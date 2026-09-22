const path = require('path');
const { z } = require('zod');
const { Tool } = require('@librechat/agents/langchain/tools');
const { VertexAI } = require('@google-cloud/vertexai');
const { logger } = require('@librechat/data-schemas');
const { formatGroundingResponse, extractGroundingResponse } = require('../util/vertexGrounding');
const {
    parseTierConfig,
    buildTierQuery,
    runCascade,
    formatAnswer,
    buildRankedQuery,
    rankResponse,
} = require('../util/groundingPolicy');

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

/**
 * Mounted next to manifest.json from a ConfigMap. Absent means the tool keeps
 * its unrestricted behaviour; malformed throws, because a config that silently
 * approves nothing would reject every question.
 */
function loadSourceTiers() {
    const configPath =
        process.env.WEB_GROUNDING_SOURCES_FILE ||
        path.join(__dirname, '..', 'grounding-sources.json');
    let raw;
    try {
        raw = require(configPath);
    } catch (e) {
        logger.debug('No grounding source tiers configured; web grounding stays unrestricted.');
        return null;
    }
    return parseTierConfig(raw);
}

class WebGroundingEnterprise extends Tool {

    // Helper function for initializing properties
    _initializeField(field, envVar, defaultValue) {
        return field || process.env[envVar] || defaultValue;
    }

    constructor(fields = {}) {
        super();
        this.name = 'web_grounding_enterprise';
        this.description =
            'Use the GDPR-compliant \'web_grounding_enterprise\' tool to retrieve search results from the web.';

        /* Used to initialize the Tool without necessary variables. */
        this.override = fields.override ?? false;
        this.tiers = loadSourceTiers();
        this.maxTiers = Number(process.env.WEB_GROUNDING_MAX_TIERS) || undefined;
        // "ranked" asks once across every approved domain and orders the result;
        // "cascade" searches one tier at a time. See docs in groundingPolicy.
        this.strategy = process.env.WEB_GROUNDING_STRATEGY || 'cascade';
        this.geminiModel = fields.geminiModel || 'gemini-2.5-flash';

        let serviceKey = {};
        try {
            const keyPath = process.env.GOOGLE_SERVICE_KEY_FILE || path.join(process.cwd(), 'api', 'data', 'auth.json');
            serviceKey = require(keyPath);
        } catch (e) {
            logger.error("No Service account found.");
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
            query: z.string().describe('Search word or phrase for the Web Grounding Enterprise tool'),
        });

        // Initialize properties using helper function
        this.projectId = this.project_id
        this.location = process.env.GOOGLE_LOC

        // Check for required fields if not overridden
        if (!this.override) {
            if (!this.projectId) {
                throw new Error('Missing required field: PROJECT_ID.');
            }
            if (!this.location) {
                throw new Error('Missing required field: LOCATION.');
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

            this.generativeModel = this.vertexAI.preview.getGenerativeModel({
                model: this.geminiModel,
                tools: [{
                    "enterpriseWebSearch": {
                    }
                }]
            });

        } catch (error) {
            logger.error('Error initializing Vertex AI client:', error);
            throw new Error(
                'Failed to initialize Vertex AI client.  Check your project ID, location, and authentication details.',
            );
        }
    }

    async _ask(text) {
        const streamingResult = await this.generativeModel.generateContentStream({
            contents: [{ role: 'user', parts: [{ text }] }]
        });
        return await streamingResult.response;
    }

    async _call(data) {
        const { query } = data;

        try {
            if (!this.tiers?.length) {
                return formatGroundingResponse(await this._ask(query));
            }

            const tiers = this.tiers;
            const result =
                this.strategy === 'ranked'
                    ? rankResponse(
                        extractGroundingResponse(await this._ask(buildRankedQuery(query, tiers))),
                        tiers,
                    )
                    : await runCascade({
                        tiers,
                        maxTiers: this.maxTiers,
                        ask: async (tier) =>
                            extractGroundingResponse(await this._ask(buildTierQuery(query, tier))),
                    });

            if (!result.hit) {
                logger.debug(`Web grounding found no approved source for: ${query}`);
            }
            return formatAnswer(result);
        } catch (error) {
            logger.error('Web Grounding for Enterprise request failed', error);
            return 'There was an error with the Web Grounding for Enterprise Search.';
        }
    }
}

module.exports = WebGroundingEnterprise;