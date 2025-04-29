const { logger } = require('~/config');
const axios = require('axios').default;
const { getGSUrl } = require('~/server/services/Files/GCS');

class ImagenClient {

  constructor(options, modelName) {
    if (!options || !options.authOptions || !options.authOptions.projectId || !options.location || !modelName) {
      throw new Error('Invalid options provided to ImagenClient');
    }
    this.url = `https://${options.endpoint}/v1/projects/${options.authOptions.projectId}/locations/${options.location}/publishers/google/models/${modelName}:predict`;
  }

  async generateImages(messages, headers, visionParams, userId) {
    try {
      const storageUri = getGSUrl({ userId, fileName: '', basePath: 'generatedImages' });
      const payloadPostRequest = {
        'instances': [
          {
            'prompt': messages.slice(-1)[0].content
          }
        ],
        'parameters': {
          'sampleCount': visionParams.visionResults,
          'addWatermark': true,
          'aspectRatio': visionParams.aspectRatio,
          'safetyFilterLevel': 'block_medium_and_above',
          'personGeneration': visionParams.visionSafety,
          'negativePrompt': visionParams.negativePrompt,
          'storageUri': storageUri ?? undefined,
        }
      }
      logger.debug(`Imagen client: Generating images with payload: ${JSON.stringify(payloadPostRequest)}`);
      const response = await axios.post(this.url, payloadPostRequest, headers);
      logger.debug(`Imagen client: Generating images Google response: ${JSON.stringify(response.data)}`);
      return response.data;
    } catch (error) {
      logger.error(`generateImages failed: ${error.message}`);
      throw error;
    }
  }
}

module.exports = ImagenClient;
