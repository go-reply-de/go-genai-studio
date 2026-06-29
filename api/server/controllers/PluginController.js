const { logger } = require('@librechat/data-schemas');
const { getToolkitKey, checkPluginAuth, filterUniquePlugins } = require('@librechat/api');
const { getCachedTools, setCachedTools } = require('~/server/services/Config');
const { availableTools, toolkits } = require('~/app/clients/tools');
const { getAppConfig } = require('~/server/services/Config');

const getAvailablePluginsController = async (req, res) => {
  try {
    const appConfig =
      req.config ??
      (await getAppConfig({
        role: req.user?.role,
        userId: req.user?.id,
        tenantId: req.user?.tenantId,
      }));
    const { filteredTools = [], includedTools = [] } = appConfig;

    const uniquePlugins = filterUniquePlugins(availableTools);
    const includeSet = new Set(includedTools);
    const filterSet = new Set(filteredTools);

    /** includedTools takes precedence — filteredTools ignored when both are set. */
    const plugins = [];
    for (const plugin of uniquePlugins) {
      if (includeSet.size > 0) {
        if (!includeSet.has(plugin.pluginKey)) {
          continue;
        }
      } else if (filterSet.has(plugin.pluginKey)) {
        continue;
      }
      plugins.push(checkPluginAuth(plugin) ? { ...plugin, authenticated: true } : plugin);
    }

    res.status(200).json(plugins);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAvailableTools = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      logger.warn('[getAvailableTools] User ID not found in request');
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const appConfig =
      req.config ??
      (await getAppConfig({
        role: req.user?.role,
        userId: req.user?.id,
        tenantId: req.user?.tenantId,
      }));

    let toolDefinitions = await getCachedTools();

    if (toolDefinitions == null && appConfig?.availableTools != null) {
      logger.warn('[getAvailableTools] Tool cache was empty, re-initializing from app config');
      await setCachedTools(appConfig.availableTools);
      toolDefinitions = appConfig.availableTools;
    }

    const uniquePlugins = filterUniquePlugins(availableTools);
    const toolDefKeysList = toolDefinitions ? Object.keys(toolDefinitions) : null;
    const toolDefKeys = toolDefKeysList ? new Set(toolDefKeysList) : null;

    const toolsOutput = [];
    for (const plugin of uniquePlugins) {
      const isToolDefined = toolDefKeys?.has(plugin.pluginKey) === true;
      const isToolkit =
        plugin.toolkit === true &&
        toolDefKeysList != null &&
        toolDefKeysList.some(
          (key) => getToolkitKey({ toolkits, toolName: key }) === plugin.pluginKey,
        );

      if (!isToolDefined && !isToolkit) {
        continue;
      }

      toolsOutput.push(checkPluginAuth(plugin) ? { ...plugin, authenticated: true } : plugin);
    }

    res.status(200).json(toolsOutput);
  } catch (error) {
    logger.error('[getAvailableTools]', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Converts MCP function format tools to plugin format
 * @param {Object} functionTools - Object with function format tools
 * @param {Object} customConfig - Custom configuration for MCP servers
 * @returns {Array} Array of plugin objects
 */
function convertMCPToolsToPlugins(functionTools, customConfig) {
  const plugins = [];

  for (const [toolKey, toolData] of Object.entries(functionTools)) {
    if (!toolData.function || !toolKey.includes(Constants.mcp_delimiter)) {
      continue;
    }

    const functionData = toolData.function;
    const parts = toolKey.split(Constants.mcp_delimiter);
    const serverName = parts[parts.length - 1];

    const serverConfig = customConfig?.mcpServers?.[serverName];

    const plugin = {
      name: parts[0], // Use the tool name without server suffix
      pluginKey: toolKey,
      description: functionData.description || '',
      authenticated: true,
      icon: serverConfig?.iconPath,
    };

    // Build authConfig for MCP tools
    if (!serverConfig?.customUserVars) {
      plugin.authConfig = [];
      plugins.push(plugin);
      continue;
    }

    const customVarKeys = Object.keys(serverConfig.customUserVars);
    if (customVarKeys.length === 0) {
      plugin.authConfig = [];
    } else {
      plugin.authConfig = Object.entries(serverConfig.customUserVars).map(([key, value]) => ({
        authField: key,
        label: value.title || key,
        description: value.description || '',
      }));
    }

    plugins.push(plugin);
  }

  return plugins;
}

module.exports = {
  getAvailableTools,
  getAvailablePluginsController,
};
