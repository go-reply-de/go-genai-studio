const { z } = require('zod');
const { Tool } = require('@langchain/core/tools');
const { GoogleAuth } = require('google-auth-library');
const { v4 } = require('uuid');
const { logger } = require('~/config'); // Assuming logger is correctly set up
const { ContentTypes } = require('librechat-data-provider');
const path = require('path');
const os = require('os');

const displayMessage =
  "The tool displayed an image. All generated images are already plainly visible, so don't repeat the descriptions in detail. Do not list download links as they are available in the UI already. The user may download the images by clicking on them, but do not mention anything about downloading to the user.";

class Imagen extends Tool {
  constructor(fields = {}, imagenModelId = 'imagegeneration@006') {
    super();

    this.name = 'imagen_vertex';
    this.description =
      `Generates an image using Google Vertex AI Imagen based on a textual prompt. ` +
      `Returns the image content and a file ID. Use this for creating original images.`;
    this.returnDirect = false;
    this.responseFormat = 'content_and_artifact';

    this.override = fields.override ?? false;

    // --- Authentication & Project Configuration ---
    let serviceKey = {};
    try {
      // Robust path for service key (assuming it might be in `../data/` relative to this file's dir)
      serviceKey = require('~/data/auth.json');
    } catch (e) {
      logger.warn(`Could not load service account. Attempting Application Default Credentials. Error: ${e.message}`);
    }

    this.location = 'us-central1';
    this.modelId = imagenModelId;
    this.serviceKey =
      serviceKey && typeof serviceKey === 'string' ? JSON.parse(serviceKey) : (serviceKey ?? {});

    /** @type {string | null | undefined} */
    this.project_id = this.serviceKey.project_id;
    this.client_email = this.serviceKey.client_email;
    this.private_key = this.serviceKey.private_key;
    this.access_token = null;

    // --- Zod Schema ---
    this.schema = z.object({
      prompt: z.string().min(1).max(4000).describe('The detailed textual prompt for image generation.'),
      n: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .default(1)
        .describe('The number of images to generate (1-4).'),
      quality: z
        .enum(['standard', 'hd'])
        .optional()
        .default('standard')
        .describe("The quality of the image: 'standard' or 'hd'."),
      size: z
        .enum(['1:1', '16:9', '9:16', '4:3', '3:4'])
        .optional()
        .default('1:1')
        .describe("The aspect ratio of the image ('1:1', '16:9', '9:16', '4:3', '3:4')."),
      negativePrompt: z.string().optional().describe('Text describing what NOT to include in the image.'),
    });

    if (this.override) {
      logger.info(`[${this.name}] Tool initialization overridden.`);
      return;
    }

    if (!this.project_id) {
      const errorMsg = `[${this.name}] Google Cloud Project ID is missing.`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    // --- Initialize the new VertexAI client and GenerativeModel ---
    // Create Vertex AI client
    try {
      const clientOptions = {};
      this.clientOptions.endpoint = `${this.location}-aiplatform.googleapis.com`;
      if (this.client_email && this.private_key && this.project_id) {
        // Use Service Account authentication
        this.clientOptions.credentials = {
          client_email: this.client_email,
          private_key: this.private_key,
        };
        this.clientOptions.projectId = this.project_id;
        logger.debug('Using Service Account for authentication.');
      }
      this.url = `https://${clientOptions.endpoint}/v1/projects/${clientOptions.projectId}/locations/${this.location}/publishers/google/models/${imagenModelId}:predict`;

    } catch (error) {
      logger.error('Error initializing Vertex AI client:', error);
      throw new Error(
        'Failed to initialize Vertex AI client.  Check your project ID, location, and authentication details.',
      );
    }
  }

  async getAccessToken() {
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    console.log('Successfully obtained access token:', accessToken);
    return accessToken;
  } catch (error) {
    console.error('Error getting access token:', error);
  }

  /**
   * The main method to generate an image using GenerativeModel.
   * @param data The input data matching the Zod schema.
   * @returns {Promise<Array>} An array with [textResponse, { content, file_ids }]
   */
  async _call(data) {
    const { prompt, n, quality, size, negativePrompt } = data;

    const headers = {
      'Authorization': "Bearer " + await this.getAccessToken(),
      'Content-Type': 'application/json; charset=utf-8',
    } 

    if (!this.generativeModel) {
      return [
        [{ type: ContentTypes.TEXT, text: `Error: ${this.name} client not initialized.` }],
        {},
      ];
    }

    logger.debug(
      `[${this.name}] Generating image with prompt: "${prompt.substring(
        0,
        100,
      )}..." (n=${n}, quality=${quality}, aspectRatio=${size})`,
    );

    try {
      // --- Construct the request for the new API ---
      const payloadPostRequest = {
        instances: {
          prompt: prompt
        },
        parameters: {
          sample_count: n,
          aspect_ratio: size,
          quality: quality,
          negative_prompt: negativePrompt,
        }
      };

      [response] = await axios.post(this.url, payloadPostRequest, { headers });

      // --- Process the new response structure ---
      const candidates = response.response.candidates;
      if (!candidates || candidates.length === 0) {
        throw new Error('Image generation failed, no candidates returned from Vertex AI.');
      }

      const imagePart = candidates[0].content.parts.find(part => part.fileData);

      if (!imagePart || !imagePart.fileData.fileUri) {
        throw new Error('Unexpected response structure: No fileData or fileUri found.');
      }

      // The new API returns a GCS URI. You need to fetch the content.
      // For simplicity, this example assumes public access or proper permissions.
      // In a real app, you'd use the GCS client to download the base64 content.
      // Here, we'll simulate this by assuming the URI contains the data.
      // NOTE: This part needs adjustment based on actual `fileUri` content if it's a GCS path.
      // A more robust solution would use @google-cloud/storage to download the file.
      // For this example, we assume `fileUri` might be a data URI for simplicity.

      let imageBase64;
      if (imagePart.fileData.fileUri.startsWith('data:')) {
        imageBase64 = imagePart.fileData.fileUri.split(',')[1];
      } else {
        // This is a placeholder. You would need to implement GCS file download here.
        logger.warn(`Received GCS URI: ${imagePart.fileData.fileUri}. Direct download not implemented in this example.`);
        // For now, we can't proceed without the image data.
        throw new Error(`Received a GCS URI, but file download from GCS is required.`);
      }

      const content = [
        {
          type: ContentTypes.IMAGE_URL,
          image_url: {
            url: `data:image/png;base64,${imageBase64}`,
          },
        },
      ];

      const file_ids = [v4()];
      const textResponse = [
        {
          type: ContentTypes.TEXT,
          text: displayMessage + `\n\ngenerated_image_id: "${file_ids[0]}"`,
        },
      ];

      return [textResponse, { content, file_ids }];

    } catch (error) {
      logger.error(
        `[${this.name}] Image generation failed for prompt "${prompt.substring(0, 100)}...": ${error.message
        }`,
      );
      if (error.code) logger.error(`[${this.name}] gRPC error code: ${error.code}`);
      if (error.details) logger.error(`[${this.name}] Error details: ${error.details}`);

      const userErrorMessage = `Error: Image generation by Vertex AI failed. Reason: ${error.message}.`;
      return [[{ type: ContentTypes.TEXT, text: userErrorMessage }], {}];
    }
  }
}

module.exports = Imagen;