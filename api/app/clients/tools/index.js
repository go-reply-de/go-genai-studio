const availableTools = require('./manifest.json');

// Structured Tools
const DALLE3 = require('./structured/DALLE3');
const FluxAPI = require('./structured/FluxAPI');
const OpenWeather = require('./structured/OpenWeather');
const StructuredWolfram = require('./structured/Wolfram');
const createYouTubeTools = require('./structured/YouTube');
const StructuredACS = require('./structured/AzureAISearch');
const StructuredSD = require('./structured/StableDiffusion');
const GoogleSearchAPI = require('./structured/GoogleSearch');
const GoogleVertexAI = require('./structured/GoogleVertexAI');
const TraversaalSearch = require('./structured/TraversaalSearch');
const createOpenAIImageTools = require('./structured/OpenAIImageTools');
const TavilySearchResults = require('./structured/TavilySearchResults');
const createVertexAIImageTool = require('./structured/Imagen');

/** @type {Record<string, TPlugin | undefined>} */
const manifestToolMap = {};

/** @type {Array<TPlugin>} */
const toolkits = [];

availableTools.forEach((tool) => {
  manifestToolMap[tool.pluginKey] = tool;
  if (tool.toolkit === true) {
    toolkits.push(tool);
  }
});

module.exports = {
  toolkits,
  availableTools,
  manifestToolMap,
  // Structured Tools
  DALLE3,
  FluxAPI,
  OpenWeather,
  StructuredSD,
  StructuredACS,
  GoogleSearchAPI,
  GoogleVertexAI,
  TraversaalSearch,
  StructuredWolfram,
  createYouTubeTools,
  TavilySearchResults,
  createOpenAIImageTools,
  createVertexAIImageTool,
};
