import { memo } from 'react';
import { BookOpen } from 'lucide-react';
import { ContentTypes } from 'librechat-data-provider';
import type { SearchResultData, TMessageContentParts } from 'librechat-data-provider';

const GROUNDING_TOOL = 'web_grounding_enterprise';
const HEADING = 'Quellen und weiterführende Literatur';

/** A streaming message can have holes where a part has not arrived yet. */
type MessageContent = Array<TMessageContentParts | undefined> | undefined;

/** The single-agent view has no source list of its own; the parallel view renders LibreChat's panel. */
export function hasGroundingSources(
  content: MessageContent,
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
  isSubmitting = false,
}: {
  message: { content?: MessageContent };
  searchResults?: Record<string, SearchResultData>;
  /** True while the agent is still answering; the sources arrive before its text. */
  isSubmitting?: boolean;
}) {
  if (isSubmitting || !hasGroundingSources(message.content, searchResults)) {
    return null;
  }
  return (
    <section
      aria-label={HEADING}
      className="border-border-medium bg-surface-secondary mt-6 rounded-xl border p-4"
    >
      <h3 className="text-text-primary mb-3 flex items-center gap-2 text-base font-semibold">
        <BookOpen className="h-5 w-5 shrink-0" aria-hidden="true" />
        {HEADING}
      </h3>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {listedSources(searchResults).map((source) => (
          <li key={source.link}>
            <a
              href={source.link}
              target="_blank"
              rel="noopener noreferrer"
              className="border-border-light bg-surface-primary text-text-primary hover:bg-surface-hover flex h-full items-center rounded-lg border px-3 py-2 text-sm font-medium transition-all duration-300"
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
