import { memo } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import type { SearchResultData, TMessage } from 'librechat-data-provider';
import Sources from '~/components/Web/Sources';
import { SearchContext } from '~/Providers';

const GROUNDING_TOOL = 'web_grounding_enterprise';

/** The single-agent view has no card panel of its own; the parallel view already renders one. */
export function hasGroundingSources(
  content: TMessage['content'],
  searchResults?: Record<string, SearchResultData>,
): boolean {
  const parts = content ?? [];
  if (parts.some((part) => part?.groupId != null)) {
    return false;
  }
  const searched = parts.some((part) => {
    if (part?.type !== ContentTypes.TOOL_CALL) {
      return false;
    }
    const toolCall = part[ContentTypes.TOOL_CALL];
    return !!toolCall && 'name' in toolCall && toolCall.name === GROUNDING_TOOL;
  });
  return searched && Object.values(searchResults ?? {}).some((result) => !!result?.organic?.length);
}

/** LibreChat's own Sources card panel under an answer grounded by web_grounding_enterprise. */
function GroundingSources({
  message,
  searchResults,
}: {
  message: TMessage;
  searchResults?: Record<string, SearchResultData>;
}) {
  if (!hasGroundingSources(message.content, searchResults)) {
    return null;
  }
  return (
    <SearchContext.Provider value={{ searchResults }}>
      <Sources messageId={message.messageId} conversationId={message.conversationId ?? undefined} />
    </SearchContext.Provider>
  );
}

export default memo(GroundingSources);
