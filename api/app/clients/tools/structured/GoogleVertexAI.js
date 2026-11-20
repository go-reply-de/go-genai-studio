const { z } = require('zod');
const { Tool } = require('@librechat/agents/langchain/tools');
const { VertexAI } = require('@google-cloud/vertexai');
const { logger } = require('@librechat/data-schemas');
const { errorStatus, withOverloadRetry } = require('@librechat/api');
const path = require('path');
const { formatGroundingResponse } = require('../util/vertexGrounding');

/** Gemini 3 and later take a thinking level; older models keep their default budget. */
const THINKING_LEVEL_MODELS = /gemini-([3-9]|\d{2,})/i;
/** The agent writes the reply, so the search only gathers facts and needs little thinking. */
const SEARCH_THINKING_LEVEL = 'LOW';
/** Vertex holds an unanswered request for up to 10 minutes; one try gives up after this. */
const ATTEMPT_TIMEOUT_MS = 60000;
/** No retry starts after this, so a search ends within about two minutes. */
const RETRY_BUDGET_MS = 90000;
/** Facts instead of a finished essay: the agent rewrites the reply anyway, and less text is faster. */
const SEARCH_INSTRUCTION =
  'You answer a search request for another assistant, which writes the final reply. ' +
  'Use only the search results. Return the facts that answer the request as a compact bulleted list ' +
  'of at most about 300 words, in the language of the request, without introduction or closing remarks. ' +
  'If the results do not cover the request, say so in one sentence.';

/** The SDK aborts a timed-out request and keeps the AbortError as the cause. */
const isTimeout = (error) => error?.name === 'AbortError' || error?.cause?.name === 'AbortError';

/**
 * Vertex AI multi-region location values (e.g. `eu`, `us`) are not valid
 * regional hostnames for the Gemini generateContent API. They must be
 * mapped to their dedicated multi-region endpoint, mirroring the mapping
 * used for the main chat Vertex AI client.
 */
const VERTEX_MULTI_REGION_ENDPOINTS = {
  eu: 'aiplatform.eu.rep.googleapis.com',
  us: 'aiplatform.us.rep.googleapis.com',
  global: 'aiplatform.googleapis.com',
};

class GoogleVertexAI extends Tool {
  // Helper function for initializing properties
  _initializeField(field, envVar, defaultValue) {
    return field || process.env[envVar] || defaultValue;
  }

  constructor(fields = {}) {
    super();
    this.name = 'vertex_ai_search';
    this.description =
      "Use the 'vertex_ai_search' tool to retrieve search results from a Vertex AI Search data store relevant to your input.";

    this.override = fields.override ?? false;
    this.geminiModel = fields.geminiModel || 'gemini-2.5-flash';

    /** @type {boolean} */
    if (!this.override && !fields.isAgent) {
      throw new Error('This tool is only available for agents.');
    }

    let serviceKey = {};
    try {
      const keyPath =
        process.env.GOOGLE_SERVICE_KEY_FILE || path.join(process.cwd(), 'api', 'data', 'auth.json');
      serviceKey = require(keyPath);
    } catch {
      logger.error('No Service account found.');
    }

    this.serviceKey =
      serviceKey && typeof serviceKey === 'string' ? JSON.parse(serviceKey) : (serviceKey ?? {});

    /** @type {string | null | undefined} */
    this.project_id = this.serviceKey.project_id;
    this.client_email = this.serviceKey.client_email;
    this.private_key = this.serviceKey.private_key;
    this.access_token = null;

    // Define schema
    this.schema = z.object({
      query: z.string().describe('Search word or phrase to Vertex AI Search'),
    });

    // Initialize properties using helper function
    this.projectId = this.project_id;
    this.location = process.env.GOOGLE_LOC;
    this.dataStoreId = this._initializeField(
      fields.VERTEX_AI_DATASTORE_ID,
      'VERTEX_AI_DATASTORE_ID',
    );

    // Check for required fields if not overridden
    if (!this.override) {
      if (!this.projectId) {
        throw new Error('Missing required field: PROJECT_ID.');
      }
      if (!this.location) {
        throw new Error('Missing required field: LOCATION.');
      }
      if (!this.dataStoreId) {
        throw new Error('Missing required field: VERTEX_AI_DATASTORE_ID.');
      }
    }

    if (!this.client_email && !this.private_key) {
      console.warn(
        'Warning: No Service Account credentials provided.  Ensure the Compute Engine default service account has the Vertex AI User role if running on a Compute Engine instance.',
      );
    }

    if (this.override) {
      return;
    }

    // Create Vertex AI client
    try {
      const authOptions = {};
      if (this.client_email && this.private_key && this.project_id) {
        // Use Service Account authentication
        authOptions.credentials = {
          client_email: this.client_email,
          private_key: this.private_key,
        };
        authOptions.projectId = this.project_id;
        logger.debug('Using Service Account for authentication.');
      }
      // Initialize the Vertex AI client, passing in the authentication options
      const multiRegionEndpoint = VERTEX_MULTI_REGION_ENDPOINTS[this.location];
      this.vertexAI = new VertexAI({
        project: this.projectId,
        location: this.location,
        googleAuthOptions: authOptions,
        ...(multiRegionEndpoint ? { apiEndpoint: multiRegionEndpoint } : {}),
      });

      const retrievalTool = this.createGroundingTool();

      this.generativeModel = this.vertexAI.preview.getGenerativeModel(
        {
          model: this.geminiModel,
          tools: [retrievalTool],
          systemInstruction: SEARCH_INSTRUCTION,
          ...(THINKING_LEVEL_MODELS.test(this.geminiModel)
            ? { generationConfig: { thinkingConfig: { thinkingLevel: SEARCH_THINKING_LEVEL } } }
            : {}),
        },
        { timeout: ATTEMPT_TIMEOUT_MS },
      );
    } catch (error) {
      logger.error('Error initializing Vertex AI client:', error);
      throw new Error(
        'Failed to initialize Vertex AI client.  Check your project ID, location, and authentication details.',
      );
    }
  }

  createGroundingTool() {
    return {
      retrieval: {
        vertexAiSearch: {
          datastore: this.dataStoreId,
        },
        disableAttribution: false,
      },
    };
  }

  /** A timed-out try carries 408, so the overload retry treats it like a timeout from Google. */
  async _generate(request) {
    try {
      return await this.generativeModel.generateContent(request);
    } catch (error) {
      if (errorStatus(error) == null && isTimeout(error)) {
        throw Object.assign(
          new Error(`Vertex AI Search gave no answer within ${ATTEMPT_TIMEOUT_MS / 1000} s`),
          { status: 408, cause: error },
        );
      }
      throw error;
    }
  }

  async _call(data) {
    const { query } = data;
    const request = { contents: [{ role: 'user', parts: [{ text: query }] }] };

    try {
      const result = await withOverloadRetry(() => this._generate(request), {
        deadline: Date.now() + RETRY_BUDGET_MS,
      });
      return formatGroundingResponse(result.response);
    } catch (error) {
      logger.error('Vertex AI Search request failed', error);
      return 'There was an error with Vertex AI Search.';
    }
  }
}

module.exports = GoogleVertexAI;
