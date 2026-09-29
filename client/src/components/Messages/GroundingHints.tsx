import { memo, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { visit } from 'unist-util-visit';
import type { Pluggable } from 'unified';
import type { SearchResultData } from 'librechat-data-provider';
import { useSearchContext } from '~/Providers';

const DIRECTIVE = 'hinweise';
const NOTE_DIRECTIVE = 'quellenvermerk';
const NOTE_CLASSES =
  'not-prose my-3 rounded-xl border border-amber-400 bg-amber-50/70 px-4 py-2 text-sm text-amber-950 dark:border-amber-500/60 dark:bg-amber-900/20 dark:text-amber-100';
const HEADING = 'Ergänzende Hinweise – bitte eigenständig prüfen';
/** Names what the source list holds instead of calling it "official". */
const EXPLANATION =
  'Diese Angaben sind nicht durch AWMF, Fachgesellschaften, Behörden (z. B. RKI, BfArM, EMA) oder die Fachinformation belegt. Sie stammen aus anderen Quellen oder lassen sich keiner Quelle zuordnen.';
const NO_SOURCE = 'ohne Quelle';

type HintSource = { domain: string; link: string };
type HintItem = { text: string; sources: HintSource[] };
/** `items` are what an unbacked lead-in introduces. */
type Hint = HintItem & { topic: string | null; items?: HintItem[] };
type Results = Record<string, SearchResultData> | undefined;

/** web_grounding_enterprise hands its unofficial statements over with the search results. */
function hintsOf(searchResults: Results): Hint[] {
  const seen = new Set<string>();
  const hints: Hint[] = [];
  for (const result of Object.values(searchResults ?? {})) {
    for (const hint of (result as { hints?: Hint[] } | undefined)?.hints ?? []) {
      if (hint?.text && !seen.has(hint.text)) {
        seen.add(hint.text);
        hints.push(hint);
      }
    }
  }
  return hints;
}

export const hasHints = (searchResults: Results) => hintsOf(searchResults).length > 0;

/** Sources off the list come marked `official: false`. */
const hasListedSources = (searchResults: Results) =>
  Object.values(searchResults ?? {}).some((result) =>
    result?.organic?.some((source) => (source as { official?: boolean }).official !== false),
  );

type DirectiveNode = { name?: string; data?: Record<string, unknown>; children?: unknown[] };

/** `::hinweise` on a line of its own marks where the agent wants the hints panel.
 * `::quellenvermerk[…]` opens an answer no listed source backs and shows as a highlighted note. */
export const groundingHintsPlugin: Pluggable = () => (tree) => {
  visit(tree, 'leafDirective', (node: DirectiveNode) => {
    if (node.name === DIRECTIVE) {
      node.data = { ...node.data, hName: 'grounding-hints', hProperties: {} };
    } else if (node.name === NOTE_DIRECTIVE) {
      node.data = {
        ...node.data,
        hName: 'div',
        hProperties: { className: NOTE_CLASSES, role: 'note' },
      };
      node.children = [{ type: 'text', value: '⚠ ' }, ...(node.children ?? [])];
    }
  });
};

export const hasHintsMarker = (text: string) =>
  new RegExp(`^[ \\t]*::${DIRECTIVE}[ \\t]*$`, 'm').test(text);

/** A copied answer keeps the note as plain text and leaves the hints marker out; the hints
 * themselves are never part of the text. */
export const stripGroundingMarkup = (text: string) =>
  text
    .replace(new RegExp(`^[ \\t]*::${NOTE_DIRECTIVE}\\[(.*)\\][ \\t]*$`, 'gm'), '$1')
    .replace(
      new RegExp(`\\n*^[ \\t]*::${DIRECTIVE}[ \\t]*$\\n*`, 'gm'),
      (marker, at: number, whole: string) =>
        at === 0 || at + marker.length === whole.length ? '' : '\n\n',
    );

/** Only neighbours share a group, so the order of the answer stays. */
function byTopic(hints: Hint[]) {
  const groups: Array<{ topic: string | null; hints: Hint[] }> = [];
  for (const hint of hints) {
    const last = groups[groups.length - 1];
    if (last && last.topic === hint.topic) {
      last.hints.push(hint);
    } else {
      groups.push({ topic: hint.topic, hints: [hint] });
    }
  }
  return groups;
}

function HintSources({ sources }: { sources: HintSource[] }) {
  if (!sources.length) {
    return (
      <span className="ml-1.5 rounded bg-surface-tertiary px-1.5 text-[11px] text-text-secondary">
        {NO_SOURCE}
      </span>
    );
  }
  return (
    <>
      {sources
        .filter((s, i, all) => all.findIndex((o) => o.domain === s.domain) === i)
        .map((source) => (
          <a
            key={source.link}
            href={source.link}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1.5 text-xs text-amber-800 underline dark:text-amber-300"
          >
            {source.domain}
          </a>
        ))}
    </>
  );
}

/** Collapsed next to an answer listed sources back. Without them the agent's answer already is
 * the text of the other sources, so there is no panel. */
function GroundingHints({ searchResults: given }: { searchResults?: Results }) {
  const context = useSearchContext();
  const searchResults = given ?? context?.searchResults;
  const hints = hintsOf(searchResults);
  const [open, setOpen] = useState(false);
  const explanationId = useId();
  if (!hints.length || !hasListedSources(searchResults)) {
    return null;
  }
  const count = hints.reduce((sum, hint) => sum + 1 + (hint.items?.length ?? 0), 0);
  return (
    <section
      aria-label={HEADING}
      className="not-prose my-4 rounded-xl border border-amber-400 bg-amber-50/70 px-4 py-2 dark:border-amber-500/60 dark:bg-amber-900/20"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-describedby={explanationId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 py-1 text-left text-sm font-semibold text-amber-950 dark:text-amber-100"
      >
        <span>
          ⚠ {HEADING} ({count})
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <p id={explanationId} className="pb-1 text-xs text-amber-900 dark:text-amber-200/90">
        {EXPLANATION}
      </p>
      {open && (
        <div className="pb-2">
          {byTopic(hints).map((group, index) => (
            <div key={`${index}:${group.topic ?? ''}`} className="mt-2">
              {group.topic && (
                <div className="text-sm font-semibold text-text-primary">{group.topic}</div>
              )}
              <ul className="list-disc space-y-1 pl-5 text-sm text-text-primary">
                {group.hints.map((hint) => (
                  <li key={hint.text}>
                    {hint.text}
                    <HintSources sources={hint.sources} />
                    {!!hint.items?.length && (
                      <ul className="mt-1 list-[circle] space-y-1 pl-5">
                        {hint.items.map((item) => (
                          <li key={item.text}>
                            {item.text}
                            <HintSources sources={item.sources} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const MemoGroundingHints = memo(GroundingHints);
export { MemoGroundingHints as GroundingHints };
export default MemoGroundingHints;
