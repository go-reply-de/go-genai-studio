const { z } = require('zod');
const { Tool } = require('@langchain/core/tools');
const { PredictionServiceClient, helpers } = require('@google-cloud/aiplatform');
const { v4 } = require('uuid');
const { logger } = require('~/config'); // Assuming logger is correctly set up
const fs = require('fs').promises;
const path = require('path');
const os = require('os'); // For a temporary directory
const { ContentTypes } = require('librechat-data-provider');

// --- Define ContentTypes if not already available globally ---
// This should match what your Langchain setup expects.

// Default display message
const DEFAULT_DISPLAY_MESSAGE = 'Image generated successfully by Vertex AI Imagen.';

const displayMessage =
  'The tool displayed an image. All generated images are already plainly visible, so don\'t repeat the descriptions in detail. Do not list download links as they are available in the UI already. The user may download the images by clicking on them, but do not mention anything about downloading to the user.';


class Imagen extends Tool {

  // _initializeField - keep as is if used, though not explicitly used in provided constructor
  _initializeField(field, envVar, defaultValue) {
    return field || process.env[envVar] || defaultValue;
  }

  constructor(fields = {}, imagenModelId = 'imagen-3.0-generate-002') {
    super(); // Call the parent Tool constructor

    // --- Tool Name and Description (Update these to be more specific) ---
    this.name = 'imagen_vertex'; // More specific name
    this.description =
      `Generates an image using Google Vertex AI Imagen based on a textual prompt. ` +
      `Returns the image content and a file ID. Use this for creating original images.`;
    this.returnDirect = false; // Standard for tools that return structured output

    // *** CRITICAL FIX: Inform the LangChain runtime about the output format ***
    this.responseFormat = 'content_and_artifact';

    this.override = fields.override ?? false;

    // --- Authentication & Project Configuration (largely same, ensure paths are robust) ---
    let serviceKey = {};
    try {
      // Robust path for service key (assuming it might be in `../data/` relative to this file's dir)
      serviceKey = require('~/data/auth.json');
    } catch (e) {
      logger.warn(`Could not load service account. Attempting Application Default Credentials. Error: ${e.message}`);
    }

    this.serviceKey = serviceKey && typeof serviceKey === 'string' ? JSON.parse(serviceKey) : (serviceKey ?? {});

    // Prioritize fields passed to constructor, then env vars, then service key
    this.project_id = this.serviceKey.project_id;
    this.client_email = this.serviceKey.client_email;
    this.private_key = this.serviceKey.private_key;
    this.location = 'us-central1';
    this.modelId = imagenModelId;


    // --- UPDATED Zod Schema (Matches OpenAI tool structure where applicable) ---
    this.schema = z.object({
      prompt: z.string().min(1).max(4000) // Vertex AI models often have prompt limits
        .describe('The detailed textual prompt for image generation (max 4000 chars recommended).'),
      n: z.number().int().min(1).max(4) // Vertex AI typically supports 1-4 images (sampleCount)
        .optional()
        .default(1)
        .describe('The number of images to generate. Must be between 1 and 4. Defaults to 1.'),
      // 'background' is not directly supported by Vertex AI Imagen generation, so it's omitted.
      // 'output_compression' is also not directly applicable for base64 PNGs.
      quality: z.enum(['standard', 'hd']) // Typical for Imagen 2+
        .optional()
        .default('standard')
        .describe("The quality of the image. One of 'standard' (default) or 'hd'. Support depends on the model."),
      size: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']) // Aspect ratios for Vertex AI
        .optional()
        .default('1:1')
        .describe(
          "The aspect ratio of the generated image. E.g., '1:1' (default square), '16:9' (landscape), '9:16' (portrait).",
        ),
      negativePrompt: z.string().optional()
        .describe('Optional text describing what NOT to include in the image.'),
      // Add other supported Vertex AI parameters here if needed
    });

    if (this.override) {
      logger.info(`[${this.name}] Tool initialization overridden.`);
      return;
    }

    if (!this.project_id) {
      const errorMsg = `[${this.name}] Google Cloud Project ID is missing. Please set GOOGLE_CLOUD_PROJECT or provide it in serviceKey or constructor fields.`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const clientOptions = {
      apiEndpoint: `${this.location}-aiplatform.googleapis.com`,
    };

    if (this.client_email && this.private_key) {
      clientOptions.credentials = {
        client_email: this.client_email,
        private_key: this.private_key, // Handle escaped newlines in private key
      };
      clientOptions.projectId = this.project_id;
      logger.debug(`[${this.name}] Initializing PredictionServiceClient with Service Account.`);
    } else {
      logger.debug(`[${this.name}] Initializing PredictionServiceClient with Application Default Credentials for project ${this.project_id}.`);
      clientOptions.projectId = this.project_id; // Good to be explicit even for ADC
    }

    try {
      this.predictionServiceClient = new PredictionServiceClient(clientOptions);
      logger.info(`[${this.name}] Vertex AI PredictionServiceClient initialized for project ${this.project_id} in ${this.location} using model ${this.modelId}.`);
    } catch (error) {
      logger.error(`[${this.name}] Error initializing Vertex AI PredictionServiceClient:`, error);
      throw new Error(
        `[${this.name}] Failed to initialize Vertex AI PredictionServiceClient. Check project ID, location, and authentication.`,
      );
    }
  }

  /**
   * The main method to generate an image.
   * @param  data The input data matching the Zod schema.
   * @returns {Promise<Array>} An array with [textResponse, { content, file_ids }]
   */
  async _call(data) {
    // Zod schema (defined in constructor) will have already validated and provided defaults for 'data'
    const {
      prompt,
      n,
      quality,
      size,
      negativePrompt,
    } = data;

    if (!this.predictionServiceClient) {
      // This case should ideally be caught if 'override' is not true and client init fails.
      const errorResult = [
        [{ type: ContentTypes.TEXT, text: `Error: ${this.name} client not initialized.` }],
        {} // Empty artifact
      ];
      return errorResult;
    }
    if (!helpers || typeof helpers.toValue !== 'function' || typeof helpers.fromValue !== 'function') {
      const errorMsg = `[${this.name}] Error: Vertex AI helpers (toValue/fromValue) are not available. Check @google-cloud/aiplatform library version or import. It should be imported from '.v1'.`;
      logger.error(errorMsg);
      return [
        [{ type: ContentTypes.TEXT, text: errorMsg }],
        {}
      ];
    }


    const endpoint = `projects/${this.project_id}/locations/${this.location}/publishers/google/models/${this.modelId}`;
    // *** FIX: Correct the logger.debug string concatenation ***
    logger.debug(`[${this.name}] Generating image with prompt: "${prompt.substring(0, 100)}..." (n=${n}, quality=${quality}, aspectRatio=${size}) using endpoint: ${endpoint}`);

    try {
      const promptInstance = { prompt: prompt };
      const instanceValue = helpers.toValue(promptInstance);
      const instances = [instanceValue];

      // Construct parameters for Vertex AI Imagen
      const generationParams = {
        sampleCount: n,
        aspectRatio: size,
        safetyFilterLevel: 'block_some',
        personGeneration: 'allow_adult',
        addWatermark: true,
      };
      // Add quality if the model supports it.
      // For Imagen 3.0 models, 'quality' is a valid parameter ('standard', 'hd')
      if (this.modelId.includes('imagen-3.0') || this.modelId.includes('imagegeneration@006')) { // Add other model checks if necessary
        generationParams.quality = quality;
      }

      const parametersValue = helpers.toValue(generationParams);

      const request = {
        endpoint,
        instances,
        parameters: parametersValue,
      };

      const [response] = await this.predictionServiceClient.predict(request);

      if (response.predictions && response.predictions.length > 0) {

        const prediction = helpers.fromValue(response.predictions[0]);

        if (prediction.bytesBase64Encoded) {
          const imageBase64 = prediction.bytesBase64Encoded;

          let content = [
            {
              type: ContentTypes.IMAGE_URL,
              image_url: {
                url: `data:image/png;base64,${imageBase64}`
              },
            },
          ];

          const file_ids = [v4()];
          // *** FIX: Ensure the text response is correctly formatted as an array of objects ***
          const textResponse = [
            {
              type: ContentTypes.TEXT,
              text: displayMessage + `\n\ngenerated_image_id: "${file_ids[0]}"`,
            },
          ];
          return [textResponse, { content, file_ids }];

        } else if (prediction.error) {
          const errorMsg = `Error from Vertex AI: ${prediction.error.message || JSON.stringify(prediction.error)}.`;
          logger.error(`[${this.name}] Vertex AI Prediction Error in response: ${JSON.stringify(prediction.error)}`);
          return [
            [{ type: ContentTypes.TEXT, text: errorMsg }],
            {}
          ];
        } else {
          const errorMsg = 'Error: Image generation failed, unexpected response structure from Vertex AI (no bytesBase64Encoded or error).';
          logger.error(`[${this.name}] Vertex AI Prediction Error: No "bytesBase64Encoded" or "error" field. Prediction: ${JSON.stringify(prediction)}`);
          return [
            [{ type: ContentTypes.TEXT, text: errorMsg }],
            {}
          ];
        }
      } else {
        let errorMsg = 'Error: Image generation failed, no predictions returned from Vertex AI.';
        if (response.error && response.error.message) {
          errorMsg += ` Details: ${response.error.message}`;
        }
        logger.error(`[${this.name}] Vertex AI Prediction Error: No predictions returned. Response: ${JSON.stringify(response)}`);
        return [
          [{ type: ContentTypes.TEXT, text: errorMsg }],
          {}
        ];
      }
    } catch (error) {
      // *** FIX: Correct the logger.error string concatenation here as well ***
      logger.error(`[${this.name}] Image generation failed for prompt "${prompt.substring(0, 100)}...": ${error.message}`);
      if (error.code) logger.error(`[${this.name}] gRPC error code: ${error.code}`);
      if (error.details) logger.error(`[${this.name}] Error details: ${error.details}`);

      let userErrorMessage = `Error: Image generation by Vertex AI failed. Reason: ${error.message}.`;
      if (error.details && typeof error.details === 'string') {
        if (error.details.includes("Invalid resource field value")) {
          userErrorMessage += ` This often means a parameter name or its value is incorrect for the model. Check parameters like 'aspectRatio', 'quality'. Details: ${error.details}`;
        }
      }
      return [
        [{ type: ContentTypes.TEXT, text: userErrorMessage }],
        {}
      ];
    }
  }
}

module.exports = Imagen;