const { z } = require('zod');
const { Tool } = require('@langchain/core/tools');
const { VertexAI } = require('@google-cloud/vertexai');
const { logger } = require('~/config');

class MedLM extends Tool {

    // Helper function for initializing properties
    _initializeField(field, envVar, defaultValue) {
        return field || process.env[envVar] || defaultValue;
    }

    constructor(fields = {}, medlmModel = "medlm-large-1.5") {
        super();
        this.name = 'medlm';
        this.description = 'Use the \'medlm\' tool to interact with Google Cloud\'s MedLM model.';

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
            query: z.string().describe('Input query or prompt for the MedLM model'),
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

            this.generativeModel = this.vertexAI.getGenerativeModel({
                model: medlmModel
            });

        } catch (error) {
            logger.error('Error initializing MedLM client:', error);
            throw new Error(
                'Failed to initialize MedLM client.  Check your project ID, location, and authentication details.',
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
            logger.error('Vertex AI Search request failed', error);
            return 'There was an error with Vertex AI Search.';
        }
    }
}

module.exports = MedLM;