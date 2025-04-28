const { VertexAI } = require('@google-cloud/vertexai');
const { ChatVertexAI } = require('@langchain/google-vertexai');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { GoogleGenerativeAI: GenAI } = require('@google/generative-ai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const {
  validateVisionModel,
  getResponseSender,
  endpointSettings,
  EModelEndpoint,
  Constants,
} = require('librechat-data-provider');
const { encodeAndFormat } = require('~/server/services/Files/images');
const { getModelMaxTokens } = require('~/utils');
const { sleep } = require('~/server/utils');
const { logger } = require('~/config');
const GoogleClient = require('./GoogleClient');

const loc = process.env.GOOGLE_LOC || 'us-central1';

const settings = endpointSettings[EModelEndpoint.goreply];
const EXCLUDED_GENAI_MODELS = /gemini-(?:1\.0|1-0|pro)/;
const DEFAULT_STREAM_DELAY = 8;
const GENERATIVE_MODEL_STREAM_DELAY = 12;
const FLASH_MODEL_STREAM_DELAY = 5;
const GROUNDING_SOURCES_TEXT = "\n \n**Grounding Sources:** \n";
const OLDER_GEMINI_MODELS = ["gemini-1.5", "gemini-1.0", "medlm"];

const MODEL_TYPE = {
  GEMINI_1_5: '1.5',
  FLASH: 'flash',
  IMAGEN: 'imagen'
}


class GoReplyClient extends GoogleClient {

  constructor(credentials, options = {}) {
    super(credentials, { ...options, skipSetOptions: true });
    this.setOptions(options);
  }

  /* Required Client methods */
  setOptions(options) {
    if (this.options && !this.options.replaceOptions) {
      // nested options aren't spread properly, so we need to do this manually
      this.options.modelOptions = {
        ...this.options.modelOptions,
        ...options.modelOptions,
      };
      delete options.modelOptions;
      // now we can merge options
      this.options = {
        ...this.options,
        ...options,
      };
    } else {
      this.options = options;
    }

    this.modelOptions = this.options.modelOptions || {};

    this.options.attachments?.then((attachments) => this.checkVisionRequest(attachments));

    /** @type {boolean} Whether using a "GenerativeAI" Model */
    this.isGenerativeModel =
      this.modelOptions.model.includes('gemini') || this.modelOptions.model.includes('learnlm');

    this.maxContextTokens =
      this.options.maxContextTokens ??
      getModelMaxTokens(this.modelOptions.model, EModelEndpoint.goreply);

    // The max prompt tokens is determined by the max context tokens minus the max response tokens.
    // Earlier messages will be dropped until the prompt is within the limit.
    this.maxResponseTokens = this.modelOptions.maxOutputTokens || settings.maxOutputTokens.max;

    if (this.maxContextTokens > 32000) {
      this.maxContextTokens = this.maxContextTokens - this.maxResponseTokens;
    }

    this.maxPromptTokens =
      this.options.maxPromptTokens || this.maxContextTokens - this.maxResponseTokens;

    if (this.maxPromptTokens + this.maxResponseTokens > this.maxContextTokens) {
      throw new Error(
        `maxPromptTokens + maxOutputTokens (${this.maxPromptTokens} + ${this.maxResponseTokens} = ${
          this.maxPromptTokens + this.maxResponseTokens
        }) must be less than or equal to maxContextTokens (${this.maxContextTokens})`,
      );
    }

    this.sender =
      this.options.sender ??
      getResponseSender({
        model: this.modelOptions.model,
        endpoint: EModelEndpoint.goreply,
        modelLabel: this.options.modelLabel,
      });

    this.userLabel = this.options.userLabel || 'User';
    this.modelLabel = this.options.modelLabel || 'Assistant';

    if (this.options.reverseProxyUrl) {
      this.completionsUrl = this.options.reverseProxyUrl;
    } else {
      this.completionsUrl = this.constructUrl();
    }

    let promptPrefix = (this.options.promptPrefix ?? '').trim();
    if (typeof this.options.artifactsPrompt === 'string' && this.options.artifactsPrompt) {
      promptPrefix = `${promptPrefix ?? ''}\n${this.options.artifactsPrompt}`.trim();
    }
    this.systemMessage = promptPrefix;
    this.initializeClient();
    return this;
  }

  /**
   *
   * Checks if the model is a vision model based on request attachments and sets the appropriate options:
   * @param {MongoFile[]} attachments
   */
  checkVisionRequest(attachments) {
    /* Validation vision request */
    this.defaultVisionModel = this.options.visionModel ?? 'gemini-pro-vision';
    const availableModels = this.options.modelsConfig?.[EModelEndpoint.goreply];
    this.isVisionModel = validateVisionModel({ model: this.modelOptions.model, availableModels });

    if (
      attachments &&
      attachments.some((file) => file?.type && file?.type?.includes('image')) &&
      availableModels?.includes(this.defaultVisionModel) &&
      !this.isVisionModel
    ) {
      this.modelOptions.model = this.defaultVisionModel;
      this.isVisionModel = true;
    }

    if (this.isVisionModel && !attachments && this.modelOptions.model.includes('gemini-pro')) {
      this.modelOptions.model = 'gemini-pro';
      this.isVisionModel = false;
    }
  }

  /**
   *
   * Adds image URLs to the message object and returns the files
   *
   * @param {TMessage[]} messages
   * @param {MongoFile[]} files
   * @returns {Promise<MongoFile[]>}
   */
  async addImageURLs(message, attachments, mode = '') {
    const { files, image_urls } = await encodeAndFormat(
      this.options.req,
      attachments,
      EModelEndpoint.goreply,
      mode,
    );
    message.image_urls = image_urls.length ? image_urls : undefined;
    return files;
  }

  createLLM(clientOptions) {
    const model = clientOptions.modelName ?? clientOptions.model;
    clientOptions.location = loc;
    clientOptions.endpoint = `${loc}-aiplatform.googleapis.com`;
    if (clientOptions.isGrounded) {
      logger.debug('Creating Google Grounded VertexAI client');
      return new VertexAI({ project: this.project_id, location: loc, googleAuthOptions: clientOptions.authOptions });
    } else if (model.includes('imagen')) {
      logger.debug('Creating Imagen client')
      return new ImagenClient(clientOptions, model);
    } else if (this.project_id && this.isTextModel) {
      logger.debug('Creating Google VertexAI client');
      return new ChatVertexAI(clientOptions);
    } else if (this.project_id && this.isChatModel) {
      logger.debug('Creating Chat Google VertexAI client');
      return new ChatVertexAI(clientOptions);
    } else if (model.includes('medlm')) {
      logger.debug('Creating client for MedLM Models');
      return new VertexAI({ project: this.project_id, location: loc, googleAuthOptions: clientOptions.authOptions });
    } else if (this.project_id) {
      logger.debug('Creating VertexAI client');
      return new VertexAI({ project: this.project_id, location: loc, googleAuthOptions: clientOptions.authOptions });
    } else if (!EXCLUDED_GENAI_MODELS.test(model)) {
      logger.debug('Creating GenAI client');
      return new GenAI(this.apiKey).getGenerativeModel(
        {
          ...clientOptions,
          model,
        }
      );
    }
    logger.debug('Creating Chat Google Generative AI client');
    return new ChatGoogleGenerativeAI({ ...clientOptions, apiKey: this.apiKey });
  }

  getStreamDelay(modelName) {
    if (!this.options?.streamRate) {
      if (this.isGenerativeModel) {
        return GENERATIVE_MODEL_STREAM_DELAY;
      }
      if (modelName?.includes(MODEL_TYPE.FLASH)) {
        return FLASH_MODEL_STREAM_DELAY;
      }
    }
    return this.options?.streamRate || DEFAULT_STREAM_DELAY;
  }

  async handleStream(result, onProgress, delay, streamRate) {
    let reply = '';
    for await (const item of result.stream) {
      const chunkText = item?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      await this.generateTextStream(chunkText, onProgress, {
        delay,
      });
      reply += chunkText;
      await sleep(streamRate);
    }
    return reply
  }

  async handleGenerateContentStream(result, onProgress, delay, streamRate) {
    let reply = '';
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      await this.generateTextStream(chunkText, onProgress, {
        delay,
      });
      reply += chunkText;
      await sleep(streamRate);
    }
    return reply;
  }

  async getGroundingSources(groundingMetadata, clientOptions, response) {

    let updatedGroundingMetadata = groundingMetadata;
    if (clientOptions.groundingOption === "Vertex AI Search") {
      const groundingSupports = response.candidates[0].groundingMetadata.groundingSupports;
      const groundingChunkIndices = new Set();
      groundingSupports.forEach((item) => {
        item.groundingChunkIndices.forEach((index) => {
          groundingChunkIndices.add(index);
        });
      });

      const distinctIndices = Array.from(groundingChunkIndices);
      updatedGroundingMetadata = groundingMetadata.filter((_, index) => distinctIndices.includes(index))
    }

    const extractedMetadata = updatedGroundingMetadata.map(item => ({
      title: item.web?.title || item.retrievedContext?.title,
      uri: item.web?.uri || item.retrievedContext?.uri
    }));

    const groundingSources = (() => { 
      const validItems = extractedMetadata?.filter(item =>
        typeof item.uri === 'string'
      );
    
      if (!validItems || validItems.length === 0) {
        return null;
      }
    
      const formattedSources = validItems.map((item, index) => {
        if(item.uri.startsWith('gs://')){
          return `${index + 1} - ${item.title}`;
        } 
        return `${index + 1} - [${item.title}](${item.uri})`;
      });
    
      return formattedSources.join('\n');
    })();

    return groundingSources
  }

  async handleGroundedModel(model, messages, clientOptions, _payload, systemInstruction, onProgress, streamRate) {

    let reply = '';
    const retrievalTool = this.createGroundingTool(clientOptions);
    const filterParams = { ..._payload.parameters };
    this.filterParams(filterParams);

    const generativeModelPreview = model.preview.getGenerativeModel({
      model: this.modelOptions.model,
      safetySettings: [_payload.safetySettings],
      generationConfig: { ...filterParams },
      tools: [retrievalTool]
    });

    const delay = this.getStreamDelay(clientOptions?.modelName || '');
    const history = this.getHistory(messages);
    const chat = generativeModelPreview.startChat({ history: history, systemInstruction: systemInstruction });

    const result = await chat.sendMessageStream([history[history.length - 1].parts]);
    reply = await this.handleStream(result, onProgress, delay, streamRate);

    // Get aggregated response
    const response = await result.response;

    // Get grounding metadata
    let groundingMetadata = response?.candidates?.[0]?.groundingMetadata?.groundingChunks

    if (groundingMetadata) {
      const groundingSources = await this.getGroundingSources(groundingMetadata, clientOptions, response)
      if (groundingSources) {
        reply += GROUNDING_SOURCES_TEXT + groundingSources;
      }
    }

    return reply;
  }

  async handleImagenModel(modelClient, messages, userId, visionParams) {
    try {
      const headers = {
        'Authorization': "Bearer " + await this.getAccessToken(),
        'Content-Type': 'application/json; charset=utf-8',
      }
      const responseData = await modelClient.generateImages(messages, headers, visionParams, userId);
      const formattedImages = await this.generateAndFormatImages(responseData, userId);
      return formattedImages;
    } catch (error) {
      const errorMessage = `Error occurred during image generation or upload to storage: ${error.message}`;
      throw new Error(errorMessage);
    }
  }

  async handleDefaultModel(model, messages, _payload, systemInstruction, onProgress, streamRate) {

    const filterParams = { ..._payload.parameters };
    this.filterParams(filterParams);

    const generativeModel = model.getGenerativeModel({
      model: this.modelOptions.model,
      safetySettings: [_payload.safetySettings],
      generationConfig: { ...filterParams }
    });

    const history = this.getHistory(messages);
    const chat = generativeModel.startChat({ history: history, systemInstruction: systemInstruction });
    const result = await chat.sendMessageStream([history[history.length - 1].parts]);

    return this.handleStream(result, onProgress, this.getStreamDelay(this.modelOptions.model), streamRate)
  }

  async handleGemini15Model(model, _payload, clientOptions, systemInstruction, onProgress, streamRate) {

    const requestOptions = {
      contents: _payload,
    };

    if (this.options?.promptPrefix?.length) {
      requestOptions.systemInstruction = systemInstruction
    }

    requestOptions.safetySettings = _payload.safetySettings;

    const delay = this.getStreamDelay(clientOptions?.modelName || '');
    const result = await model.generateContentStream(requestOptions);
    return this.handleGenerateContentStream(result, onProgress, delay, streamRate);
  }

  async getCompletion(_payload, options = {}) {
    const { parameters, instances } = _payload;
    const { onProgress, abortController } = options;
    const streamRate = this.options.streamRate ?? Constants.DEFAULT_STREAM_RATE;
    const { messages: _messages, context, examples: _examples } = instances?.[0] ?? {};

    let examples;

    let clientOptions = { ...parameters, maxRetries: 2 };

    let promptPrefix = (this.options.promptPrefix ?? '').trim();

    let systemInstruction = {
      parts: [
        { text: promptPrefix }
      ]
    }

    if (typeof this.options.artifactsPrompt === 'string' && this.options.artifactsPrompt) {
      promptPrefix = `${promptPrefix ?? ''}\n${this.options.artifactsPrompt}`.trim();
    }

    if (this.project_id) {
      clientOptions['authOptions'] = {
        credentials: {
          ...this.serviceKey,
        },
        projectId: this.project_id,
      };
    }

    if (!parameters) {
      clientOptions = { ...clientOptions, ...this.modelOptions };
    }

    if (this.isGenerativeModel && !this.project_id) {
      clientOptions.modelName = clientOptions.model;
      delete clientOptions.model;
    }

    if (_examples && _examples.length) {
      examples = _examples
        .map((ex) => {
          const { input, output } = ex;
          if (!input || !output) {
            return undefined;
          }
          return {
            input: new HumanMessage(input.content),
            output: new AIMessage(output.content),
          };
        })
        .filter((ex) => ex);

      clientOptions.examples = examples;
    }

    const modelClient = this.createLLM(clientOptions);
    const messages = this.isTextModel ? _payload.trim() : _messages;

    if (!this.isVisionModel && context && messages?.length > 0) {
      messages.unshift(new SystemMessage(context));
    }

    const modelName = clientOptions.modelName ?? clientOptions.model ?? '';

    if (!EXCLUDED_GENAI_MODELS.test(modelName) && !this.project_id) {
      return this.handleGemini15Model(modelClient, _payload, clientOptions, systemInstruction, onProgress, streamRate)
    }

    if (clientOptions.isGrounded) {
      return this.handleGroundedModel(modelClient, messages, clientOptions, _payload, systemInstruction, onProgress, streamRate);
    }

    if (clientOptions.model.includes(MODEL_TYPE.IMAGEN)) {
      const userId = options.user;
      const visionParams = this.options.vision;
      return this.handleImagenModel(modelClient, messages, userId, visionParams);
    }

    return this.handleDefaultModel(modelClient, messages, _payload, systemInstruction, onProgress, streamRate)
  }

  // Filter the model params to be compatible with the grounding
  filterParams(params) {
    delete params.model;
    delete params.stop;
    delete params.isGrounded;
    delete params.groundingPath;
    delete params.groundingOption;
    delete params.defaultGroundingOption;
  }

  // Create a grounding tool
  createGroundingTool(clientOptions) {
    // Handle the Vertex AI Search
    if (clientOptions.groundingOption !== "Google Search") {
      return {
        retrieval: {
          vertexAiSearch: {
            datastore: clientOptions.groundingPath,
          },
          disableAttribution: false,
        },
      };
    }

    // Handle Google Search
    const isOlderModel = OLDER_GEMINI_MODELS.some(olderModel =>
      clientOptions.model.includes(olderModel)
    );

    const searchKey = isOlderModel ? 'googleSearchRetrieval' : 'googleSearch';

    return { [searchKey]: {} };
  }

  // Get the chat history for the grounding.
  getHistory(messages) {
    let history = [];
    for (const message of messages) {
      const content = message['lc_kwargs']['content'];
      let parts = [];

      if (Array.isArray(content)) {
        parts = content.map(part => {
          const { type, ...rest } = part;
          return rest;
        });
      } else {
        parts = [{ text: content }];
      }

      history.push({
        role: message['lc_kwargs']['role'] || 'model',
        parts: parts,
      });
    }
    return history;
  }

  /**
   * Stripped-down logic for generating a title. This uses the non-streaming APIs, since the user does not see titles streaming
   */
  async titleChatCompletion(_payload, options = {}) {
    const { abortController } = options;
    const { parameters, instances } = _payload;
    const { messages: _messages, examples: _examples } = instances?.[0] ?? {};

    let clientOptions = { ...parameters, maxRetries: 2 };

    logger.debug('Initialized title client options');

    if (this.project_id) {
      clientOptions['authOptions'] = {
        credentials: {
          ...this.serviceKey,
        },
        projectId: this.project_id,
      };
    }

    if (!parameters) {
      clientOptions = { ...clientOptions, ...this.modelOptions };
    }

    if (this.isGenerativeModel && !this.project_id) {
      clientOptions.modelName = clientOptions.model;
      delete clientOptions.model;
    }
    // Generate the title using the normal VertexAI module and not the preview one
    // Reset Grounding and maxOutputTokens
    clientOptions.isGrounded = false;
    clientOptions.maxOutputTokens = settings.maxOutputTokens.default;

    const model = new ChatVertexAI(clientOptions);

    let reply = '';
    const messages = this.isTextModel ? _payload.trim() : _messages;

    const modelName = clientOptions.modelName ?? clientOptions.model ?? '';
    if (!EXCLUDED_GENAI_MODELS.test(modelName) && !this.project_id) {
      logger.debug('Identified titling model as GenAI version');
      /** @type {GenerativeModel} */
      const client = model;
      const requestOptions = {
        contents: _payload,
      };

      let promptPrefix = (this.options.promptPrefix ?? '').trim();
      if (typeof this.options.artifactsPrompt === 'string' && this.options.artifactsPrompt) {
        promptPrefix = `${promptPrefix ?? ''}\n${this.options.artifactsPrompt}`.trim();
      }

      if (this.options?.promptPrefix?.length) {
        requestOptions.systemInstruction = {
          parts: [
            {
              text: promptPrefix,
            },
          ],
        };
      }

      const safetySettings = _payload.safetySettings;
      requestOptions.safetySettings = safetySettings;

      const result = await client.generateContent(requestOptions);

      reply = result.response?.text();

      return reply;
    } else {
      logger.debug('Beginning titling');
      const safetySettings = _payload.safetySettings;

      const titleResponse = await model.invoke(messages, {
        signal: abortController.signal,
        timeout: 7000,
        safetySettings: safetySettings,
      });

      reply = titleResponse.content;
      // TODO: RECORD TOKEN USAGE
      return reply;
    }
  }

}
module.exports = GoReplyClient;
