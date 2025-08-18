const { z } = require('zod');
const { Tool } = require('@langchain/core/tools');
const { VertexAI } = require('@google-cloud/vertexai');
const { logger } = require('~/config');

class WebGroundingEnterprise extends Tool {

    // Helper function for initializing properties
    _initializeField(field, envVar, defaultValue) {
        return field || process.env[envVar] || defaultValue;
    }

    constructor(geminiModel) {
        super();
        this.name = 'web_grounding_enterprise';
        this.description =
            'Use the GDPR-compliant \'web_grounding_enterprise\' tool to retrieve search results from the web.';

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
        this.access_token = null;


        // Define schema
        this.schema = z.object({
            query: z.string().describe('Search word or phrase to Vertex AI Search'),
        });

        // Initialize properties using helper function
        this.projectId = this.project_id
        this.location = process.env.GOOGLE_LOC

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
            this.vertexAI = new VertexAI({
                project: this.projectId,
                location: this.location,
                googleAuthOptions: authOptions,
            });

            this.generativeModel = this.vertexAI.preview.getGenerativeModel({
                model: geminiModel,
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

    async _call(data) {
        const { query } = data;

        try {
            const streamingResult = await this.generativeModel.generateContentStream({
                contents: [{ role: 'user', parts: [{ text: query }] }]
            })
            const aggregatedResponse = await streamingResult.response;
            return JSON.stringify(aggregatedResponse);
        } catch (error) {
            logger.error('Web Grounding for Enterprise request failed', error);
            return 'There was an error with the Web Grounding for Enterprise Search.';
        }
    }
}

module.exports = WebGroundingEnterprise;