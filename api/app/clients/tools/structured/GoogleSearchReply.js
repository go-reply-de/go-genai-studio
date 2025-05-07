const { z } = require('zod');
const { Tool } = require('@langchain/core/tools');
const { VertexAI } = require('@google-cloud/vertexai');
const { logger } = require('~/config');

class GoogleSearchReply extends Tool {

    // Helper function for initializing properties
    _initializeField(field, envVar, defaultValue) {
        return field || process.env[envVar] || defaultValue;
    }

    constructor(fields = {}, geminiModel) {
        super();
        this.name = 'google_search';
        this.description =
            'A search engine optimized for comprehensive, accurate, and trusted results. Useful for when you need to answer questions about current events.';

        /* Used to initialize the Tool without necessary variables. */
        this.override = fields.override ?? false;

        let serviceKey = {};
        try {
            serviceKey = require('~/data/auth.json');
        } catch (e) {
            logger.error("Please upload a service account to this path: ~/data/auth.json")
        }

        this.serviceKey =
            serviceKey && typeof serviceKey === 'string' ? JSON.parse(serviceKey) : (serviceKey ?? {});

        /** @type {string | null | undefined} */
        this.project_id = this.serviceKey.project_id;
        this.client_email = this.serviceKey.client_email;
        this.private_key = this.serviceKey.private_key;

        // Define schema
        this.schema = z.object({
            query: z.string().describe('The search query string'),
        });

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
            this.vertexAI = new VertexAI({
                project: this.project_id,
                location: "us-central1",
                googleAuthOptions: authOptions,
            });

            const retrievalTool = this.createGroundingTool()

            this.generativeModel = this.vertexAI.preview.getGenerativeModel({
                model: geminiModel,
                tools: [retrievalTool]
            });

        } catch (error) {
            logger.error('Error initializing Google Search client:', error);
            throw new Error(
                'Failed to initialize Google Search client.  Check your project ID, location, and authentication details.',
            );
        }
    }

    createGroundingTool() {
        return {
            googleSearch: {}
        }
    }

    async _call(data) {
        const { query } = data;

        try {
            const streamingResult = await this.generativeModel.generateContentStream({
                contents: [{ role: 'user', parts: [{ text: query }] }]
            })
            const aggregatedResponse = await streamingResult.response;
            return JSON.stringify(aggregatedResponse);
        } catch (error) {
            logger.error('Google Search request failed', error);
            return 'There was an error with Google Search.';
        }
    }
}

module.exports = GoogleSearchReply;