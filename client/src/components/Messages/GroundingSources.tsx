import { memo } from 'react';
import { BookOpen } from 'lucide-react';
import { ContentTypes } from 'librechat-data-provider';
import type { SearchResultData, TMessage } from 'librechat-data-provider';
import {
  GroundingHints,
  hasHints,
  hasHintsMarker,
  placedSections,
} from '~/components/Messages/GroundingHints';

const GROUNDING_TOOL = 'web_grounding_enterprise';
const HEADING = 'Quellen und weiterführende Literatur';

type Organic = NonNullable<SearchResultData['organic']>[number];

/** A source off the list keeps its chip in the answer but stays out of this block. */
const isOfficial = (source: Organic) => (source as { official?: boolean }).official !== false;

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
  return (
    searched &&
    Object.values(searchResults ?? {}).some((result) => !!result?.organic?.some(isOfficial))
  );
}

const textOf = (content: TMessage['content']) =>
  (content ?? [])
    .filter((part) => part?.type === ContentTypes.TEXT)
    .map((part) => (typeof part.text === 'string' ? part.text : (part.text?.value ?? '')))
    .join('\n');

/** Each official source once, in the order the searches returned them. */
function listedSources(searchResults?: Record<string, SearchResultData>) {
  const titleByLink = new Map<string, string>();
  for (const result of Object.values(searchResults ?? {})) {
    for (const source of result?.organic ?? []) {
      if (isOfficial(source) && source.link && !titleByLink.has(source.link)) {
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
  message: TMessage;
  searchResults?: Record<string, SearchResultData>;
  /** True while the agent is still answering; the sources arrive before its text. */
  isSubmitting?: boolean;
}) {
  if (isSubmitting || !hasGroundingSources(message.content, searchResults)) {
    return null;
  }
  // Without the agent's closing marker, the hints it did not place show above the sources instead.
  const text = textOf(message.content);
  const hintsHere = !hasHintsMarker(text) && hasHints(searchResults);
  return (
    <>
      {hintsHere && <GroundingHints searchResults={searchResults} placed={placedSections(text)} />}
      <section
        aria-label={HEADING}
        className="mt-6 rounded-xl border border-border-medium bg-surface-secondary p-4"
      >
        <h3 className="mb-3 flex items-center gap-2 text-base font-semibold text-text-primary">
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
                className="flex h-full items-center rounded-lg border border-border-light bg-surface-primary px-3 py-2 text-sm font-medium text-text-primary transition-all duration-300 hover:bg-surface-hover"
              >
                <span className="truncate">{source.title}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export default memo(GroundingSources);
