const path = require('path');
const { z } = require('zod');
const { Tool } = require('@librechat/agents/langchain/tools');
const { VertexAI } = require('@google-cloud/vertexai');
const { Tools } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');
const {
    errorStatus,
    withOverloadRetry,
    isRetryableStatus,
    isOverloadRetryEnabled,
} = require('@librechat/api');
const { extractGroundingResponse } = require('../util/vertexGrounding');
const {
    parsePolicyConfig,
    buildGroundingPrompt,
    resultDomains,
    parseSourceBlock,
    mergeSources,
    anchorClaims,
    formatAnswer,
    toOrganicSources,
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

/** Overload retries stop starting once a search has run this long, the retry on an empty result included. */
const RETRY_BUDGET_MS = 20000;

const SEARCH_ERROR = 'There was an error with the Web Grounding for Enterprise Search.';
const SEARCH_UNAVAILABLE =
    'WARNUNG: Die Websuche ist gerade nicht verfügbar, es liegen keine Suchergebnisse vor. ' +
    'Sag dem Nutzer, dass die Suche fehlgeschlagen ist und in einer Minute erneut versucht werden kann. ' +
    'Gib keine Aussage als durch eine Suche belegt aus.';
const SEARCH_FAILED =
    'WARNUNG: Die Websuche ist fehlgeschlagen, es liegen keine Suchergebnisse vor. ' +
    'Sag dem Nutzer, dass die Suche fehlgeschlagen ist. Gib keine Aussage als durch eine Suche belegt aus.';

const warned = new Set();
function warnOnce(message) {
    if (!warned.has(message)) {
        warned.add(message);
        logger.warn(message);
    }
}

/** Mounted next to manifest.json from the grounding-sources ConfigMap. */
function loadPolicy() {
    const configPath =
        process.env.WEB_GROUNDING_SOURCES_FILE ||
        path.join(__dirname, '..', 'grounding-sources.json');
    let raw = null;
    try {
        raw = require(configPath);
    } catch (e) {
        logger.debug('No grounding source config mounted.');
    }
    const policy = parsePolicyConfig(raw);
    if (!policy.excludeDomains.length) {
        warnOnce('web_grounding_enterprise has no exclusion list configured; searching without exclusions.');
    }
    return policy;
}

function contentsOf(text) {
    return { contents: [{ role: 'user', parts: [{ text }] }] };
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
            'GDPR-compliant web search for medical information that looks in the AWMF guideline register ' +
            'and the AWMF societies first. Use it only when you do not know the topic well enough ' +
            'or the user asks for a web search.';
        this.responseFormat = 'content_and_artifact';

        /* Used to initialize the Tool without necessary variables. */
        this.override = fields.override ?? false;
        this.policy = loadPolicy();
        this.geminiModel = process.env.WEB_GROUNDING_MODEL || fields.geminiModel || 'gemini-2.5-flash';
        /** Thinking past LOW makes Gemini Flash search in rounds and return no attributable chunks. */
        this.thinkingLevel = process.env.WEB_GROUNDING_THINKING_LEVEL;
        this.retryOverload = isOverloadRetryEnabled();

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
                tools: [{ enterpriseWebSearch: { excludeDomains: this.policy.excludeDomains } }],
                ...(this.thinkingLevel
                    ? { generationConfig: { thinkingConfig: { thinkingLevel: this.thinkingLevel } } }
                    : {}),
            });

        } catch (error) {
            logger.error('Error initializing Vertex AI client:', error);
            throw new Error(
                'Failed to initialize Vertex AI client.  Check your project ID, location, and authentication details.',
            );
        }
    }

    /** One search call, retried on overload within the search's budget when VERTEX_RETRY_OVERLOAD is set. */
    _generate(request, deadline) {
        const call = () => this.generativeModel.generateContent(request);
        return this.retryOverload ? withOverloadRetry(call, { deadline }) : call();
    }

    /** An empty result leaves nothing to cite, so it earns exactly one more attempt. */
    async _search(query) {
        const request = contentsOf(buildGroundingPrompt(query));
        const deadline = Date.now() + RETRY_BUDGET_MS;
        const first = extractGroundingResponse((await this._generate(request, deadline)).response);
        if (resultDomains(first.chunks).length) {
            return first;
        }
        logger.info('Web grounding returned no attributable results; retrying once.');
        return extractGroundingResponse((await this._generate(request, deadline)).response);
    }

    /** Tells the agent the search did not run, so it says so instead of answering unsourced. */
    _failure(error) {
        if (!this.retryOverload) {
            return SEARCH_ERROR;
        }
        return isRetryableStatus(errorStatus(error)) ? SEARCH_UNAVAILABLE : SEARCH_FAILED;
    }

    /** The text is what the agent reads; the artifact feeds LibreChat's Sources panel. */
    async _call(data, _runManager, config) {
        const { query } = data;

        try {
            const { text, chunks, supports } = await this._search(query);
            const { sources } = parseSourceBlock(text);
            const { entries, dropped, numbering } = mergeSources({ sources, chunks, supports });
            const turn = config?.toolCall?.turn ?? 0;

            const answer = formatAnswer({
                body: anchorClaims({ text, supports, chunks, entries, numbering, turn }),
                entries,
                dropped,
                grounded: resultDomains(chunks).length > 0,
            });
            if (!entries.length) {
                return [answer, undefined];
            }
            return [answer, { [Tools.web_search]: { turn, organic: toOrganicSources(entries) } }];
        } catch (error) {
            logger.error('Web Grounding for Enterprise request failed', error);
            return [this._failure(error), undefined];
        }
    }
}

module.exports = WebGroundingEnterprise;
