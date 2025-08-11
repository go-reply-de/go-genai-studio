import React, { memo, useCallback } from 'react';
import { MultiSelect, MCPIcon } from '@librechat/client';
import MCPServerStatusIcon from '~/components/MCP/MCPServerStatusIcon';
import { useMCPServerManager } from '~/hooks/MCP/useMCPServerManager';
import MCPConfigDialog from '~/components/MCP/MCPConfigDialog';

function MCPSelect() {
  const {
    configuredServers,
    mcpValues,
    isPinned,
    placeholderText,
    batchToggleServers,
    getServerStatusIconProps,
    getConfigDialogProps,
    isInitializing,
    localize,
  } = useMCPServerManager();

  // Use the shared initialization hook
  const { initializeServer, isInitializing, connectionStatus, cancelOAuthFlow, isCancellable } =
    useMCPServerInitialization({
      onSuccess: (serverName) => {
        // Add to selected values after successful initialization
        const currentValues = mcpValues ?? [];
        if (!currentValues.includes(serverName)) {
          setMCPValues([...currentValues, serverName]);
        }
      },
      onError: (serverName) => {
        // Find the tool/server configuration
        const tool = mcpToolDetails?.find((t) => t.name === serverName);
        const serverConfig = startupConfig?.mcpServers?.[serverName];
        const serverStatus = connectionStatus[serverName];

        // Check if this server would show a config button
        const hasAuthConfig =
          (tool?.authConfig && tool.authConfig.length > 0) ||
          (serverConfig?.customUserVars && Object.keys(serverConfig.customUserVars).length > 0);

        // Only open dialog if the server would have shown a config button
        // (disconnected/error states always show button, connected only shows if hasAuthConfig)
        const wouldShowButton =
          !serverStatus ||
          serverStatus.connectionState === 'disconnected' ||
          serverStatus.connectionState === 'error' ||
          (serverStatus.connectionState === 'connected' && hasAuthConfig);

        if (!wouldShowButton) {
          return; // Don't open dialog if no button would be shown
        }

        // Create tool object if it doesn't exist
        const configTool = tool || {
          name: serverName,
          pluginKey: `${Constants.mcp_prefix}${serverName}`,
          authConfig: serverConfig?.customUserVars
            ? Object.entries(serverConfig.customUserVars).map(([key, config]) => ({
                authField: key,
                label: config.title,
                description: config.description,
              }))
            : [],
          authenticated: false,
        };

        previousFocusRef.current = document.activeElement as HTMLElement;

        // Open the config dialog on error
        setSelectedToolForConfig(configTool);
        setIsConfigModalOpen(true);
      },
    });

  const renderSelectedValues = useCallback(
    (values: string[], placeholder?: string) => {
      if (values.length === 0) {
        return placeholder || localize('com_ui_select') + '...';
      }
      if (values.length === 1) {
        return values[0];
      }
      return localize('com_ui_x_selected', { 0: values.length });
    },
    [localize],
  );

  const renderItemContent = useCallback(
    (serverName: string, defaultContent: React.ReactNode) => {
      const statusIconProps = getServerStatusIconProps(serverName);
      const isServerInitializing = isInitializing(serverName);

      /**
       Common wrapper for the main content (check mark + text).
       Ensures Check & Text are adjacent and the group takes available space.
        */
      const mainContentWrapper = (
        <button
          type="button"
          className={`flex flex-grow items-center rounded bg-transparent p-0 text-left transition-colors focus:outline-none ${
            isServerInitializing ? 'opacity-50' : ''
          }`}
          tabIndex={0}
          disabled={isServerInitializing}
        >
          {defaultContent}
        </button>
      );

      const statusIcon = statusIconProps && <MCPServerStatusIcon {...statusIconProps} />;

      if (statusIcon) {
        return (
          <div className="flex w-full items-center justify-between">
            {mainContentWrapper}
            <div className="ml-2 flex items-center">{statusIcon}</div>
          </div>
        );
      }

      return mainContentWrapper;
    },
    [getServerStatusIconProps, isInitializing],
  );

  if ((!mcpValues || mcpValues.length === 0) && !isPinned) {
    return null;
  }

  if (!configuredServers || configuredServers.length === 0) {
    return null;
  }

  const configDialogProps = getConfigDialogProps();

  return (
    <>
      <MultiSelect
        items={configuredServers}
        selectedValues={mcpValues ?? []}
        setSelectedValues={batchToggleServers}
        renderSelectedValues={renderSelectedValues}
        renderItemContent={renderItemContent}
        placeholder={placeholderText}
        popoverClassName="min-w-fit"
        className="badge-icon min-w-fit"
        selectIcon={<MCPIcon className="icon-md text-text-primary" />}
        selectItemsClassName="border border-blue-600/50 bg-blue-500/10 hover:bg-blue-700/10"
        selectClassName="group relative inline-flex items-center justify-center md:justify-start gap-1.5 rounded-full border border-border-medium text-sm font-medium transition-all md:w-full size-9 p-2 md:p-3 bg-transparent shadow-sm hover:bg-surface-hover hover:shadow-md active:shadow-inner"
      />
      {configDialogProps && <MCPConfigDialog {...configDialogProps} />}
    </>
  );
}

export default memo(MCPSelect);
