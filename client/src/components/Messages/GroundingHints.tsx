import { memo, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { visit } from 'unist-util-visit';
import type { Pluggable } from 'unified';
import type { SearchResultData } from 'librechat-data-provider';
import { Citation, CompositeCitation } from '~/components/Web/Citation';
import { SearchContext, useMessageContext, useSearchContext } from '~/Providers';

const DIRECTIVE = 'hinweise';
const NOTE_DIRECTIVE = 'quellenvermerk';
const NOTE_CLASSES =
  'not-prose my-3 rounded-xl border border-amber-400 bg-amber-50/70 px-4 py-2 text-sm text-amber-950 dark:border-amber-500/60 dark:bg-amber-900/20 dark:text-amber-100';
const HEADING = 'Ergänzende Hinweise – bitte eigenständig prüfen';
/** Names what the source list holds instead of calling it "official". */
const EXPLANATION =
  'Diese Angaben sind nicht durch AWMF, Fachgesellschaften, Behörden (z. B. RKI, BfArM, EMA) oder die Fachinformation belegt. Sie stammen aus anderen Quellen oder lassen sich keiner Quelle zuordnen.';
const NO_SOURCE = 'ohne Quelle';
const ONE_HINT = 'ergänzender Hinweis';
const MANY_HINTS = 'ergänzende Hinweise';
const CHECK = 'bitte eigenständig prüfen';

type HintSource = { domain: string; link: string };
type HintItem = { text: string; sources: HintSource[] };
/** `items` are what an unbacked lead-in introduces; `turn` is the search the hint came from;
 * `section` names the block under its section, `lead` what the text above it does not say. */
type Hint = HintItem & {
  topic: string | null;
  items?: HintItem[];
  turn: number;
  section?: string;
  lead?: string;
};
type Results = Record<string, SearchResultData> | undefined;

/** web_grounding_enterprise hands its unofficial statements over with the search results. */
function hintsOf(searchResults: Results): Hint[] {
  const seen = new Set<string>();
  const hints: Hint[] = [];
  for (const [key, result] of Object.entries(searchResults ?? {})) {
    const { turn = Number(key), hints: given = [] } =
      (result as { turn?: number; hints?: Hint[] } | undefined) ?? {};
    for (const hint of given) {
      if (hint?.text && !seen.has(hint.text)) {
        seen.add(hint.text);
        hints.push({ ...hint, turn });
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

type DirectiveNode = {
  name?: string;
  attributes?: Record<string, string | null | undefined>;
  data?: Record<string, unknown>;
  children?: unknown[];
};

/** Agents sometimes write the anchor `\\ue202turn0search0` as `[turn0search0, turn0search1]`;
 * read that as the anchors it stands for, so the chips still appear. */
const BRACKET_ANCHORS = /\[(turn\d+search\d+(?:\s*,\s*turn\d+search\d+)*)\]/g;
const asAnchors = (text: string) =>
  text.replace(BRACKET_ANCHORS, (_, list: string) => {
    const ids = list.split(/\s*,\s*/);
    const anchors = ids.map((id) => `\\ue202${id}`).join('');
    return ids.length > 1 ? `\\ue200${anchors}\\ue201` : anchors;
  });

/** `::hinweise{abschnitt=0-1}` marks where the hints of one section go, `::hinweise` alone
 * where those the agent did not place go. `::quellenvermerk[…]` opens an answer no listed source
 * backs and shows as a highlighted note. */
export const groundingHintsPlugin: Pluggable = () => (tree) => {
  visit(tree, 'text', (node: { value: string }) => {
    node.value = asAnchors(node.value);
  });
  visit(tree, 'leafDirective', (node: DirectiveNode) => {
    if (node.name === DIRECTIVE) {
      const section = node.attributes?.abschnitt;
      node.data = {
        ...node.data,
        hName: 'grounding-hints',
        hProperties: section ? { section } : {},
      };
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

/** The sections whose hint block the agent kept in its answer. */
export const placedSections = (text: string) =>
  new Set(
    [
      ...text.matchAll(
        new RegExp(`^[ \\t]*::${DIRECTIVE}\\{abschnitt=([^}\\s]+)\\}[ \\t]*$`, 'gm'),
      ),
    ].map((m) => m[1]),
  );

/** A copied answer keeps the note as plain text and leaves the hints markers out; the hints
 * themselves are never part of the text. */
export const stripGroundingMarkup = (text: string) =>
  asAnchors(text)
    .replace(new RegExp(`^[ \\t]*::${NOTE_DIRECTIVE}\\[(.*)\\][ \\t]*$`, 'gm'), '$1')
    .replace(
      new RegExp(`\\n*^[ \\t]*::${DIRECTIVE}(?:\\{[^}\\n]*\\})?[ \\t]*$\\n*`, 'gm'),
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

/** The chips of the answer, once each source is among the search results; answers saved before
 * the other sources were put there only have the links. */
function HintSources({
  sources,
  turn,
  searchResults,
}: {
  sources: HintSource[];
  turn: number;
  searchResults: Results;
}) {
  const organic = searchResults?.[turn]?.organic ?? [];
  const citations = sources
    .map((source) => organic.findIndex((entry) => entry.link === source.link))
    .filter((index) => index >= 0)
    .map((index) => ({ turn, refType: 'search', index }));
  if (sources.length && citations.length === sources.length) {
    const citationId = `hint-${turn}-${citations.map((c) => c.index).join('-')}`;
    return citations.length === 1 ? (
      <Citation
        citationId={citationId}
        citationType="standalone"
        node={{ properties: { citation: citations[0], citationId } }}
      />
    ) : (
      <CompositeCitation citationId={citationId} node={{ properties: { citations, citationId } }} />
    );
  }
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

function HintEntry({
  hint,
  lead,
  searchResults,
}: {
  hint: Hint;
  lead?: string;
  searchResults: Results;
}) {
  return (
    <li>
      {lead && <span className="font-semibold">{lead}: </span>}
      {hint.text}
      <HintSources sources={hint.sources} turn={hint.turn} searchResults={searchResults} />
      {!!hint.items?.length && (
        <ul className="mt-1 list-[circle] space-y-1 pl-5">
          {hint.items.map((item) => (
            <li key={item.text}>
              {item.text}
              <HintSources sources={item.sources} turn={hint.turn} searchResults={searchResults} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

const countOf = (hints: Hint[]) =>
  hints.reduce((sum, hint) => sum + 1 + (hint.items?.length ?? 0), 0);

/** One line under its section; the explanation and the points open on click. */
function SectionHints({ hints, searchResults }: { hints: Hint[]; searchResults: Results }) {
  const [open, setOpen] = useState(false);
  const explanationId = useId();
  const count = countOf(hints);
  return (
    <section
      aria-label={HEADING}
      className="not-prose my-2 rounded-xl border border-amber-400 bg-amber-50/70 px-4 py-1.5 dark:border-amber-500/60 dark:bg-amber-900/20"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-describedby={open ? explanationId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 py-0.5 text-left text-sm font-semibold text-amber-950 dark:text-amber-100"
      >
        <span>
          ⚠ {count} {count === 1 ? ONE_HINT : MANY_HINTS} – {CHECK}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <SearchContext.Provider value={{ searchResults }}>
          <p id={explanationId} className="pb-1 text-xs text-amber-900 dark:text-amber-200/90">
            {EXPLANATION}
          </p>
          <ul className="list-disc space-y-1 pb-1 pl-5 text-sm text-text-primary">
            {hints.map((hint) => (
              <HintEntry
                key={hint.text}
                hint={hint}
                lead={hint.lead}
                searchResults={searchResults}
              />
            ))}
          </ul>
        </SearchContext.Provider>
      )}
    </section>
  );
}

/** Sections whose block the agent kept, per message, so the closing panel shows only the rest.
 * Their blocks come earlier in the answer and so render first. */
const keptSections = new Map<string, Set<string>>();

/** With `section`, the block under that section. Without, the closing panel with every hint the
 * agent did not place: collapsed, and only next to an answer listed sources back, since without
 * them the answer already is the text of the other sources. */
function GroundingHints({
  searchResults: given,
  section,
  placed,
}: {
  searchResults?: Results;
  section?: string;
  /** The sections placed in the answer, when the caller has its text. */
  placed?: Set<string>;
}) {
  const context = useSearchContext();
  const { messageId } = useMessageContext() ?? {};
  const searchResults = given ?? context?.searchResults;
  const [open, setOpen] = useState(false);
  const explanationId = useId();
  if (!hasListedSources(searchResults)) {
    return null;
  }
  const all = hintsOf(searchResults);
  if (section) {
    if (messageId) {
      keptSections.set(messageId, (keptSections.get(messageId) ?? new Set()).add(section));
    }
    const own = all.filter((hint) => hint.section === section);
    return own.length ? <SectionHints hints={own} searchResults={searchResults} /> : null;
  }
  const kept = placed ?? (messageId ? keptSections.get(messageId) : undefined) ?? new Set();
  const hints = all.filter((hint) => !hint.section || !kept.has(hint.section));
  if (!hints.length) {
    return null;
  }
  const count = countOf(hints);
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
        <SearchContext.Provider value={{ searchResults }}>
          <div className="pb-2">
            {byTopic(hints).map((group, index) => (
              <div key={`${index}:${group.topic ?? ''}`} className="mt-2">
                {group.topic && (
                  <div className="text-sm font-semibold text-text-primary">{group.topic}</div>
                )}
                <ul className="list-disc space-y-1 pl-5 text-sm text-text-primary">
                  {group.hints.map((hint) => (
                    <HintEntry key={hint.text} hint={hint} searchResults={searchResults} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </SearchContext.Provider>
      )}
    </section>
  );
}

const MemoGroundingHints = memo(GroundingHints);
export { MemoGroundingHints as GroundingHints };
export default MemoGroundingHints;
