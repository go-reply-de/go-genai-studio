import { memo } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import type { SearchResultData, TMessage } from 'librechat-data-provider';

const GROUNDING_TOOL = 'web_grounding_enterprise';
const HEADING = 'Quellen und weiterführende Literatur';

/** The single-agent view has no source list of its own; the parallel view renders LibreChat's panel. */
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

/** Each source once, in the order the searches returned them. */
function listedSources(searchResults?: Record<string, SearchResultData>) {
  const titleByLink = new Map<string, string>();
  for (const result of Object.values(searchResults ?? {})) {
    for (const source of result?.organic ?? []) {
      if (source.link && !titleByLink.has(source.link)) {
        titleByLink.set(source.link, source.title || source.link);
      }
    }
  }
  return [...titleByLink].map(([link, title]) => ({ link, title }));
}

/** Our own list: LibreChat's panel has a fixed tab label, and its cards show Google's redirect
 * host instead of the source. */
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
    <section aria-label={HEADING} className="mt-4">
      <h3 className="mb-2 text-sm font-medium text-text-primary">{HEADING}</h3>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {listedSources(searchResults).map((source) => (
          <li key={source.link}>
            <a
              href={source.link}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-full items-center rounded-lg bg-surface-primary-contrast px-3 py-2 text-sm font-medium text-text-primary transition-all duration-300 hover:bg-surface-tertiary"
            >
              <span className="truncate">{source.title}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default memo(GroundingSources);
