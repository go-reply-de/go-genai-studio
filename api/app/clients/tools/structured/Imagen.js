const { z } = require('zod');
const { tool } = require('@langchain/core/tools');
const { PredictionServiceClient, helpers } = require('@google-cloud/aiplatform');
const { v4 } = require('uuid');
const { logger } = require('~/config');
const { ContentTypes } = require('librechat-data-provider');

// This is the message the AI will see. It instructs the AI to be concise.
const displayMessage =
  "The tool displayed an image. All generated images are already plainly visible, so don't repeat the descriptions in detail or mention download links.";

/**
 * Creates a Google Vertex AI Imagen tool.
 * @param {Object} fields - Configuration fields (can be left empty).
 * @param {string} imagenModelId - The model ID to use for image generation.
 * @returns {import('@langchain/core/tools').Tool} A LangChain tool instance.
 */
function createVertexAIImageTool(fields = {}, imagenModelId = 'imagen-3.0-generate-002') {
  let serviceKey = {};
  try {
    serviceKey = require('~/data/auth.json');
  } catch (e) {
    logger.warn('[ImagenTool] Could not load service account key. Using Application Default Credentials.');
  }

  const override = fields.override ?? false;
  if (!override && !fields.isAgent) {
    throw new Error('This tool is only available for agents.');
  }
  const { req } = fields;
  const project_id = serviceKey.project_id || process.env.GOOGLE_CLOUD_PROJECT;
  const location = 'us-central1';

  if (!project_id) {
    throw new Error('[ImagenTool] Google Cloud Project ID is missing.');
  }

  const clientOptions = {
    apiEndpoint: `${location}-aiplatform.googleapis.com`,
    projectId: project_id,
  };

  if (serviceKey.client_email && serviceKey.private_key) {
    clientOptions.credentials = {
      client_email: serviceKey.client_email,
      private_key: serviceKey.private_key,
    };
  }

  const predictionServiceClient = new PredictionServiceClient(clientOptions);

  const imagenTool = tool(
    async ({ prompt, n = 1, quality = 'standard', size = '1:1', negativePrompt }) => {
      const endpoint = `projects/${project_id}/locations/${location}/publishers/google/models/${imagenModelId}`;

      try {
        const instance = helpers.toValue({ prompt });

        const generationParams = {
          sampleCount: n,
          aspectRatio: size,
          quality: quality,
        };

        if (negativePrompt) {
          generationParams.negativePrompt = negativePrompt;
        }

        const parameters = helpers.toValue(generationParams);
        const request = { endpoint, instances: [instance], parameters };

        const [response] = await predictionServiceClient.predict(request);

        if (!response.predictions || response.predictions.length === 0) {
          throw new Error('No predictions returned from Vertex AI.');
        }

        const imageBase64 = helpers.fromValue(response.predictions[0])?.bytesBase64Encoded;

        if (!imageBase64) {
          const errorDetails = helpers.fromValue(response.predictions[0])?.error;
          throw new Error(`Vertex AI Error: ${errorDetails?.message || 'No image data in response'}`);
        }

        // **This is the critical part: The exact return structure**
        const content = [{
          type: ContentTypes.IMAGE_URL,
          image_url: { url: `data:image/png;base64,${imageBase64}` },
        }];

        const file_ids = [v4()];
        
        const textResponse = [{
          type: ContentTypes.TEXT,
          text: `${displayMessage}\n\ngenerated_image_id: "${file_ids[0]}"`,
        }];
        
        // This precise [Array, Object] structure is what the frontend expects.
        return [textResponse, { content, file_ids }];

      } catch (error) {
        logger.error('[ImagenTool] Image generation failed:', error);
        // On error, return a user-friendly string. The executor will handle it.
        return `An error occurred with the Imagen tool: ${error.message}`;
      }
    },
    {
      name: 'image_gen_vertex',
      description: 'Generates an image using Google Vertex AI Imagen from a text prompt. Use this for creating original images.',
      schema: z.object({
        prompt: z.string().min(1).max(4000).describe('A detailed text prompt for the image.'),
        n: z.number().int().min(1).max(4).optional().describe('Number of images to generate (1-4).'),
        quality: z.enum(['standard', 'hd']).optional().describe("Image quality: 'standard' or 'hd'."),
        size: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).optional().describe("Aspect ratio of the image."),
        negativePrompt: z.string().optional().describe('A prompt of what to exclude from the image.'),
      }),
      responseFormat: 'content_and_artifact'
    },
  );

  return imagenTool;
}

module.exports = createVertexAIImageTool;