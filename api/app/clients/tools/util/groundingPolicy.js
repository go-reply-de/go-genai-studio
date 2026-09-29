/** Source policy for web_grounding_enterprise: its prompt, how the model's source
 * list is checked against the real search results, and how the answer is rendered. */

const SOURCE_BLOCK_MARKER = '[[QUELLEN]]';

/** Models write `https://www.awmf.org/...` as often as `awmf.org`; both mean the host. */
function normalizeDomain(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/^www\./, '');
}

const HOSTNAME = /^(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}$/u;
const YEAR = /^(?:\d{4}|-)$/;

/** Label-aware suffix match, so `awmf.org` covers `register.awmf.org` but not `fake-awmf.org`. */
function domainMatches(domain, listed) {
  return domain === listed || domain.endsWith(`.${listed}`);
}

function domainList(value, field) {
  if (!Array.isArray(value) || value.some((d) => typeof d !== 'string' || !d.trim())) {
    throw new Error(`Grounding source config: "${field}" must be a list of domains.`);
  }
  return value.map(normalizeDomain);
}

/** Both lists come from the grounding-sources ConfigMap (terraform `grounding_exclude_domains`,
 * `grounding_source_domains`); a malformed one fails loudly, a missing one is empty. */
function parsePolicyConfig(raw) {
  const list = (field) => (raw?.[field] === undefined ? [] : domainList(raw[field], field));
  return { excludeDomains: list('excludeDomains'), sourceDomains: list('sourceDomains') };
}

function buildGroundingPrompt(query) {
  return [
    'Beantworte die medizinische Frage auf Basis einer Websuche. Stütze die Antwort',
    'ausschließlich auf tatsächlich gefundene Quellen und belege Aussagen im Text mit [n].',
    '',
    'Bevorzuge in dieser Reihenfolge: Leitlinien medizinischer Fachgesellschaften',
    '(z. B. AWMF, ESC, ERN), regulatorische und HTA-Quellen (z. B. G-BA, IQWiG, BfArM,',
    'EMA, RKI), systematische Übersichtsarbeiten und Metaanalysen, Studien in',
    'peer-reviewten Fachzeitschriften. Meide Patientenportale, Blogs und kommerzielle Seiten.',
    'Wenn nur schwache Quellen verfügbar sind, antworte trotzdem, weise aber ausdrücklich',
    'darauf hin, dass belastbare Evidenz fehlt.',
    '',
    `Beende die Antwort IMMER mit ${SOURCE_BLOCK_MARKER} und danach einer Zeile pro Quelle,`,
    'Felder durch | getrennt, ohne weitere Zeichen:',
    'Nummer (1, 2, 3 …)|Domain|Jahr oder -|Kurzbeschreibung',
    '',
    `Frage: ${query}`,
  ].join('\n');
}

/** Each distinct host the search actually returned, in order of first appearance. */
function resultDomains(chunks) {
  const hosts = (chunks ?? []).map((c) =>
    normalizeDomain((c.web ?? c.retrievedContext ?? {}).domain),
  );
  return [...new Set(hosts.filter((h) => HOSTNAME.test(h)))];
}

function parseSourceBlock(text) {
  const raw = String(text ?? '');
  const at = raw.lastIndexOf(SOURCE_BLOCK_MARKER);
  if (at < 0) {
    return { body: raw.trim(), sources: null };
  }

  const sources = raw
    .slice(at + SOURCE_BLOCK_MARKER.length)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('```'))
    .map((line) => line.split('|').map((field) => field.trim()))
    .filter((fields) => fields.length >= 2 && HOSTNAME.test(normalizeDomain(fields[1])))
    .map(([n, domain, ...rest], i) => {
      // Models drift from the format, e.g. slipping in an extra field, so locate the year.
      const y = rest.findIndex((field) => YEAR.test(field));
      return {
        // `1.1.1`-style numbers would all parse as 1; only a plain integer counts.
        n: /^\d+$/.test(n) ? Number(n) : i + 1,
        domain: normalizeDomain(domain),
        jahr: y >= 0 && rest[y] !== '-' ? rest[y] : null,
        beschreibung: (y >= 0 ? rest.slice(y + 1) : rest).join('|').trim() || null,
      };
    });

  return { body: raw.slice(0, at).trim(), sources: sources.length ? sources : null };
}

/** Only results on the source list are kept; an empty list keeps them all. A named source the
 * search never returned is dropped as fabricated, and an unnamed result stays only if the answer
 * is attributed to it. Entries carry Google's domain, not the model's. */
function mergeSources({ sources, chunks, supports, sourceDomains = [] }) {
  const listed = (domain) =>
    !sourceDomains.length || sourceDomains.some((d) => domainMatches(domain, d));
  const results = (chunks ?? [])
    .map((c) => c.web ?? c.retrievedContext ?? {})
    .map((w, index) => ({ domain: normalizeDomain(w.domain), uri: w.uri, index, claimed: false }))
    .filter((r) => HOSTNAME.test(r.domain))
    .map((r) => ({ ...r, listed: listed(r.domain) }));
  const used = new Set((supports ?? []).flatMap((s) => s.groundingChunkIndices ?? []));

  const named = [];
  const dropped = [];
  const entryOf = new Map();

  for (const s of sources ?? []) {
    const matching = results.filter(
      (r) => domainMatches(r.domain, s.domain) || domainMatches(s.domain, r.domain),
    );
    if (!matching.length) {
      dropped.push(s);
      entryOf.set(s.n, null);
      continue;
    }
    const usable = matching.filter((r) => r.listed);
    if (!usable.length) {
      entryOf.set(s.n, null);
      continue;
    }
    // Prefer an unclaimed result so two pages from one domain keep their own links;
    // with none left, the citation repeats a page that is already listed.
    const fresh = usable.find((r) => !r.claimed);
    if (!fresh) {
      entryOf.set(s.n, named.find((e) => e.uri === usable[0].uri) ?? null);
      continue;
    }
    fresh.claimed = true;
    const entry = {
      domain: fresh.domain,
      uri: fresh.uri,
      jahr: s.jahr,
      beschreibung: s.beschreibung,
    };
    named.push(entry);
    entryOf.set(s.n, entry);
  }

  const unnamed = [];
  const seen = new Set(named.map((e) => e.uri));
  for (const r of results) {
    if (!r.listed || r.claimed || seen.has(r.uri) || !used.has(r.index)) {
      continue;
    }
    seen.add(r.uri);
    unnamed.push({ domain: r.domain, uri: r.uri, jahr: null, beschreibung: null });
  }

  const entries = [...named, ...unnamed];
  const numbering = new Map([...entryOf].map(([n, e]) => [n, e ? entries.indexOf(e) + 1 : null]));
  const unlisted = [...new Set(results.filter((r) => !r.listed).map((r) => r.domain))];
  // Unlisted results the answer is attributed to; they can back the unofficial hints.
  const extras = [];
  for (const r of results) {
    if (!r.listed && used.has(r.index) && !extras.some((e) => e.uri === r.uri)) {
      extras.push({ domain: r.domain, uri: r.uri, jahr: null, beschreibung: null });
    }
  }
  return { entries, extras, dropped, numbering, unlisted };
}

const CITATION_MARKER = /\s*\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** Vertex reports segment offsets as UTF-8 bytes; JS strings index UTF-16 code units. */
function charIndexAt(text, byteOffset) {
  return Buffer.from(text, 'utf8').subarray(0, byteOffset).toString('utf8').length;
}

/** Trusts the byte offset only when it lands on the segment's own text, else finds the text. */
function segmentRange(text, segment) {
  const passage = segment?.text ?? '';
  if (!passage) {
    return null;
  }
  if (segment.endIndex != null) {
    const end = charIndexAt(text, segment.endIndex);
    if (text.slice(end - passage.length, end) === passage) {
      return { start: end - passage.length, end };
    }
  }
  const at = text.indexOf(passage);
  return at < 0 ? null : { start: at, end: at + passage.length };
}

/** Overlapping or touching passages become one. */
function mergedRanges(ranges) {
  const merged = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function anchorFor(entryIndices, turn) {
  const anchors = [...entryIndices]
    .sort((a, b) => a - b)
    .map((index) => `\\ue202turn${turn}search${index}`);
  return anchors.length === 1 ? anchors[0] : `\\ue200${anchors.join('')}\\ue201`;
}

function bodyEndOf(raw) {
  const blockAt = raw.lastIndexOf(SOURCE_BLOCK_MARKER);
  return blockAt < 0 ? raw.length : blockAt;
}

/** The model's own `[n]` markers by start offset. Same rule as the numbering: `[2023]` is not one. */
function citationMarkers(raw, bodyEnd, numbering) {
  const markers = new Map();
  for (const m of raw.slice(0, bodyEnd).matchAll(CITATION_MARKER)) {
    const numbers = m[1].split(',').map((n) => Number.parseInt(n, 10));
    if (numbers.every((n) => numbering?.has(n))) {
      markers.set(m.index, m.index + m[0].length);
    }
  }
  return markers;
}

const ABBREVIATION =
  /(?:^|[\s(])(?:z|u|d|o|s|e|ca|bzw|ggf|evtl|inkl|vgl|sog|Dr|Prof|Nr|Abb|Tab|max|min|mind|i\.v|p\.o|s\.c|i\.m|z\. ?B|d\. ?h|u\. ?a)$/i;

/** Sentence offsets within a line: a break is a sentence end followed by a capital, but not after
 * `z. B.`, `ggf.`, `i.v.` and the like, nor after an ordinal such as `1. Wahl`. */
function sentenceSpans(line) {
  const spans = [];
  let start = 0;
  for (const m of line.matchAll(/[.!?]\s+(?=\p{Lu})/gu)) {
    const before = line.slice(start, m.index);
    if (ABBREVIATION.test(before) || (line[m.index] === '.' && /\d$/.test(before))) {
      continue;
    }
    spans.push([start, m.index + 1]);
    start = m.index + m[0].length;
  }
  spans.push([start, line.length]);
  return spans.filter(([from, to]) => line.slice(from, to).trim());
}

/** A number with a dose unit. Clearance and concentration units (`ml/min`, `mmol/l`, `mg/dl`) mark
 * thresholds, not doses, so they stay. */
const DOSE =
  /\d(?:[\d.,]*\d)?\s*(?:(?:-|–|bis)\s*\d(?:[\d.,]*\d)?\s*)?(?:mg|µg|μg|mcg|ng|g|ml|l|IE|I\.\s?E\.|Einheiten|mmol|mval|Milligramm|Mikrogramm|Gramm|Milliliter|Litern?|Tabletten?|Tbl\.|Kapseln?|Ampullen?|Hübe|Hub|Tropfen)(?!\p{L})(?!\s*\/\s*(?:dl|l|min)(?!\p{L}))/iu;

const HEADING_LINE = /^\s*#{1,6}\s+(.*)$/;
const LIST_ITEM = /^(\s*)(?:[-*•+]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_RULE = /^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/;
// A model's `[5]` that names no listed source would otherwise keep a label looking like text.
const LEFTOVER_MARKER = /\s*\[\d{1,2}(?:\s*,\s*\d{1,2})*\]/g;

/** `$\ge$ 80` reads as `≥ 80`; anything more involved stays as the model wrote it. */
const MATH = /\$([^$\n]*\\[^$\n]*)\$/g;
const MATH_SYMBOLS = {
  ge: '≥',
  geq: '≥',
  le: '≤',
  leq: '≤',
  times: '×',
  pm: '±',
  cdot: '·',
  approx: '≈',
};
const plainMath = (text) =>
  text.replace(MATH, (span, inner) => {
    const out = inner
      .replace(/\\(?:text|mathrm)\{([^{}]*)\}/g, '$1')
      .replace(/\\([a-z]+)/gi, (command, name) => MATH_SYMBOLS[name] ?? command)
      .replace(/\\([%,; ])/g, (_, sign) => (sign === '%' ? '%' : ' '));
    return /[\\{}^_]/.test(out) ? span : out.trim();
  });

const tidy = (text) =>
  plainMath(text)
    .replace(LEFTOVER_MARKER, '')
    .replace(/\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** A short line ending in ':' or '?' introduces what follows; a long one also says something. */
const LABEL_LENGTH = 60;
const introduces = (text) => /[:?]$/.test(text);
const isLabel = (text) => introduces(text) && text.length <= LABEL_LENGTH;
const labelOf = (text) => text.replace(/:$/, '').trim();
/** `Kopfimpulstest (KIT): Zur Prüfung …` names what its sub-items are about. */
const inlineLabelOf = (text) => {
  const at = text.indexOf(': ');
  const label = at > 0 ? text.slice(0, at) : '';
  return label && label.length <= LABEL_LENGTH && !/[.!?]/.test(label) ? label : null;
};

/** The answer as statements: whole sentences and table rows, each with the headings, lead-ins
 * and list labels above it, so a statement keeps its meaning wherever it ends up. A long line
 * ending in ':' is both: a statement, and a `claim` context for what it introduces. */
function outlineStatements(raw, bodyEnd, markers) {
  const plain = (from, to) => {
    let out = '';
    for (let i = from; i < to; ) {
      if (markers.has(i)) {
        i = markers.get(i);
        continue;
      }
      out += raw[i];
      i += 1;
    }
    return tidy(out);
  };

  const statements = [];
  let heading = null;
  let leadIn = null;
  let leadInUsed = false;
  let leadInEnds = false;
  let labels = [];
  let header = null;
  let offset = 0;
  const lines = raw.slice(0, bodyEnd).split('\n');
  lines.forEach((line, lineIndex) => {
    const start = offset;
    offset += line.length + 1;
    const context = () => [
      ...(heading ? [{ kind: 'heading', text: heading }] : []),
      ...(leadIn ? [{ kind: 'leadIn', ...leadIn }] : []),
      ...labels.map(({ indent: _, ...label }, depth) => ({ kind: 'label', ...label, depth })),
    ];
    if (!line.trim()) {
      leadInEnds = leadIn != null && leadInUsed;
      header = null;
      return;
    }
    // A blank line between the items of one list does not end what introduced them.
    if (leadInEnds && !LIST_ITEM.test(line) && !TABLE_ROW.test(line)) {
      leadIn = null;
    }
    leadInEnds = false;
    const h = HEADING_LINE.exec(line);
    if (h) {
      heading = labelOf(plain(start + line.length - h[1].length, start + line.length));
      leadIn = null;
      labels = [];
      header = null;
      return;
    }
    if (TABLE_RULE.test(line)) {
      return;
    }
    const row = TABLE_ROW.exec(line);
    if (row) {
      const cells = row[1].split('|').map((cell) => tidy(cell));
      if (!header) {
        header = cells;
        return;
      }
      const text = cells
        .map((cell, i) => (i > 0 && header[i] ? `${header[i]}: ${cell}` : cell))
        .filter(Boolean)
        .join('; ');
      statements.push({
        from: start,
        to: start + line.length,
        text,
        context: context(),
        line: lineIndex,
        item: true,
      });
      leadInUsed = true;
      return;
    }
    header = null;

    const item = LIST_ITEM.exec(line);
    const contentStart = item ? start + line.length - item[2].length : start;
    const content = item ? item[2] : line;
    labels = item ? labels.filter((l) => l.indent < item[1].length) : [];
    const whole = plain(contentStart, start + line.length);
    if (isLabel(whole)) {
      if (item) {
        labels.push({ indent: item[1].length, text: labelOf(whole), line: lineIndex });
      } else {
        leadIn = { text: labelOf(whole) };
        leadInUsed = false;
      }
      return;
    }
    const inline = item ? inlineLabelOf(whole) : null;
    const own = [];
    for (const [from, to] of sentenceSpans(content)) {
      const text = plain(contentStart + from, contentStart + to);
      if (text) {
        own.push({
          from: contentStart + from,
          to: contentStart + to,
          text,
          context: context(),
          line: lineIndex,
          item: Boolean(item),
          // A later sentence of `Peripherer Befund: …` still speaks about that finding.
          ...(inline && !text.startsWith(inline) ? { itemLabel: inline } : {}),
        });
      }
    }
    statements.push(...own);
    if (own.length && whole.endsWith(':')) {
      const lead = own[own.length - 1];
      lead.leads = true;
      const claim = { text: inline ?? labelOf(lead.text), line: lineIndex, claim: true };
      if (!item) {
        leadIn = claim;
        leadInUsed = false;
        return;
      }
      labels.push({ indent: item[1].length, ...claim });
    } else if (inline) {
      labels.push({ indent: item[1].length, text: inline, line: lineIndex });
    }
    leadInUsed = true;
  });
  return statements;
}

/** Google's attributions as character ranges, each with the kept sources (entry indices) and the
 * extra, unlisted sources (uris) it names. */
function attributionsOf({ raw, bodyEnd, supports, chunks, entries, extras }) {
  const uriOf = (i) => ((chunks ?? [])[i]?.web ?? (chunks ?? [])[i]?.retrievedContext ?? {}).uri;
  const extraUris = new Set(extras.map((e) => e.uri));
  return (supports ?? [])
    .map((support) => {
      const uris = (support.groundingChunkIndices ?? []).map(uriOf);
      return {
        range: segmentRange(raw, support.segment),
        kept: [...new Set(uris.map((uri) => entries.findIndex((e) => e.uri === uri)))].filter(
          (i) => i >= 0,
        ),
        extra: [...new Set(uris.filter((uri) => extraUris.has(uri)))],
      };
    })
    .filter((a) => a.range && a.range.end <= bodyEnd && (a.kept.length || a.extra.length));
}

const OFFICIAL_SHARE = 0.5;

/** Statements along the outline they came from: headings, lead-ins and list labels come along
 * once, and each sentence ends with the anchors `anchorsOf` gives it. `markers` holds lines to
 * set after a source line, or before everything under -1. */
function renderOutline(statements, anchorsOf, turn, markers = new Map()) {
  const introduced = new Set(
    statements.flatMap((s) => s.context.filter((c) => c.claim).map((c) => c.line)),
  );
  const lines = [];
  // A line right under a list item or paragraph would continue it, so paragraphs get a blank line.
  const push = (line) => {
    const previous = lines[lines.length - 1];
    if (!/^\s*- /.test(line) && previous && !previous.startsWith('#')) {
      lines.push('');
    }
    lines.push(line);
  };
  const emitted = new Set();
  let path = [];
  let last = null;
  (markers.get(-1) ?? []).forEach(push);
  statements.forEach((st, at) => {
    const same = (a, b) => a && b && a.kind === b.kind && a.text === b.text;
    let common = 0;
    while (common < path.length && same(path[common], st.context[common])) {
      common += 1;
    }
    for (const c of st.context.slice(common)) {
      if (c.claim) {
        // A lead-in that says something is in the text as a statement of its own.
      } else if (c.kind === 'heading') {
        lines.push('', `### ${c.text}`);
      } else if (c.kind === 'leadIn') {
        push(introduces(c.text) ? c.text : `${c.text}:`);
      } else if (c.line == null || !emitted.has(c.line)) {
        push(`${'  '.repeat(c.depth)}- ${introduces(c.text) ? c.text : `${c.text}:`}`);
      }
    }
    const depth = st.context.filter((c) => c.kind === 'label').length;
    const joins = last && last.line === st.line && common === st.context.length;
    const said = st.leads && !introduced.has(st.line) ? st.text.replace(/:$/, '.') : st.text;
    const labelled = !joins && st.itemLabel ? `${st.itemLabel}: ${said}` : said;
    const anchors = anchorsOf(st);
    const sentence = anchors.length ? `${labelled} ${anchorFor(anchors, turn)}` : labelled;
    if (joins) {
      lines[lines.length - 1] += ` ${sentence}`;
    } else {
      push(st.item || depth ? `${'  '.repeat(depth)}- ${sentence}` : sentence);
    }
    path = st.context;
    last = st;
    emitted.add(st.line);
    if (statements[at + 1]?.line !== st.line) {
      (markers.get(st.line) ?? []).forEach(push);
    }
  });
  return lines.join('\n').trim();
}

/** Splits the answer along its outline. A statement kept sources cover at least half of goes to
 * the backed text, with its anchors and its headings, unless it depends on an unbacked lead-in;
 * the rest becomes hints, grouped by the label above them and nested under their lead-in, with
 * the unlisted sources Google names and never with a dose. `unlisted` is the same hints as text
 * with anchors on `extras`, for an answer no kept source backs. */
function splitAnswer({ text, supports, chunks, entries, extras = [], numbering, turn = 0 }) {
  const raw = String(text ?? '');
  const bodyEnd = bodyEndOf(raw);
  const markers = citationMarkers(raw, bodyEnd, numbering);
  const attributions = attributionsOf({ raw, bodyEnd, supports, chunks, entries, extras });
  const extraByUri = new Map(extras.map((e) => [e.uri, e]));

  const classified = outlineStatements(raw, bodyEnd, markers).map((st) => {
    const overlapping = attributions.filter((a) => a.range.start < st.to && a.range.end > st.from);
    const keptRanges = overlapping
      .filter((a) => a.kept.length)
      .map((a) => ({ start: Math.max(a.range.start, st.from), end: Math.min(a.range.end, st.to) }));
    const share =
      mergedRanges(keptRanges).reduce((sum, r) => sum + r.end - r.start, 0) /
      Math.max(1, st.to - st.from);
    return {
      ...st,
      official: share >= OFFICIAL_SHARE,
      kept: new Set(overlapping.flatMap((a) => a.kept)),
      extra: [...new Set(overlapping.flatMap((a) => a.extra))],
    };
  });
  // A lead-in precedes what it introduces, so its verdict is known by then. Only what it
  // introduces directly depends on it; a labelled sub-list reads on its own.
  const leadOfficial = new Map();
  const introducer = (st) => (st.context.at(-1)?.claim ? st.context.at(-1).line : null);
  for (const st of classified) {
    if (introducer(st) != null && !leadOfficial.get(introducer(st))) {
      st.official = false;
    }
    if (st.leads) {
      leadOfficial.set(st.line, st.official);
    }
  }
  const hints = [];
  const placed = [];
  // The top-level hint that holds each placed line, so what a hint introduces nests under it.
  const hintOfLine = new Map();
  const shown = (c) => !c.claim || leadOfficial.get(c.line);
  // The labels above a hint, so `Befund` under two different tests stays two topics.
  const topicOf = (st) => {
    const path = st.context.filter(
      (c, i) =>
        c.kind !== 'heading' &&
        shown(c) &&
        (c.kind === 'label' || !c.claim || i === st.context.length - 1),
    );
    return path.length
      ? path.map((c) => c.text).join(' – ')
      : (st.context.find((c) => c.kind === 'heading')?.text ?? null);
  };
  for (const st of classified.filter((s) => !s.official && !DOSE.test(s.text))) {
    const sources = st.extra.map((uri) => ({ domain: extraByUri.get(uri).domain, link: uri }));
    const owner = st.context.at(-1);
    const parent = (owner?.line != null && hintOfLine.get(owner.line)) || null;
    const siblings = parent ? parent.items : hints;
    const previous = siblings[siblings.length - 1];
    if (previous && previous.line === st.line) {
      previous.text += ` ${st.text}`;
      previous.sources.push(
        ...sources.filter((s) => !previous.sources.some((p) => p.link === s.link)),
      );
    } else if (st.text.length >= 12 && /^[\p{Lu}\d„"(]/u.test(st.text)) {
      const text = st.itemLabel ? `${st.itemLabel}: ${st.text}` : st.text;
      const topic = topicOf(st);
      siblings.push(
        parent
          ? { text, sources, line: st.line }
          : { topic, text, sources, line: st.line, items: [], first: st },
      );
    } else {
      continue;
    }
    placed.push(st);
    hintOfLine.set(st.line, parent ?? hints[hints.length - 1]);
  }

  // A hint's block goes under the backed part of its section: the list item whose sub-points it
  // is among, or else its heading. A section with nothing backed gets its block where it stood.
  const official = classified.filter((s) => s.official);
  const topLabel = (st) => st.context.find((c) => c.kind === 'label' && c.depth === 0);
  const headingOf = (st) => st.context.find((c) => c.kind === 'heading')?.text ?? '';
  const inItem = (st) => topLabel(st)?.line != null;
  const lastInItem = new Map(official.filter(inItem).map((st) => [topLabel(st).line, st]));
  const lastUnderHeading = new Map(official.map((st) => [headingOf(st), st]));
  // "Die Leitlinie nennt die folgenden Säulen:" without a source says nothing on its own.
  const framing = (hint) =>
    hint.text.endsWith(':') &&
    /\bfolgend|\bwie folgt/i.test(hint.text) &&
    !hint.items.length &&
    !hint.sources.length;
  const shownHints = hints.filter((hint) => !framing(hint));
  const blocks = new Map();
  const blockAt = new Map();
  for (const hint of shownHints) {
    const st = hint.first;
    const own = inItem(st)
      ? lastInItem.get(topLabel(st).line)
      : lastUnderHeading.get(headingOf(st));
    const anchor = own ?? official.filter((o) => o.line < st.line).at(-1);
    const at = anchor ? anchor.line : -1;
    const indent = own && inItem(st) ? 2 : 0;
    const key = `${at}:${indent}`;
    if (!blockAt.has(key)) {
      blockAt.set(key, `${turn}-${blockAt.size + 1}`);
      const marker = `${' '.repeat(indent)}${HINTS_MARKER}{abschnitt=${blockAt.get(key)}}`;
      const list = blocks.get(at) ?? [];
      // The block of a line's own section comes before that of a section with nothing backed.
      blocks.set(at, indent ? [marker, ...list] : [...list, marker]);
    }
    hint.section = blockAt.get(key);
    // Only what the text above the block does not already say.
    let shared = 0;
    while (
      anchor &&
      shared < Math.min(anchor.context.length, st.context.length) &&
      anchor.context[shared].kind === st.context[shared].kind &&
      anchor.context[shared].text === st.context[shared].text
    ) {
      shared += 1;
    }
    const sectionLine = own ? topLabel(st)?.line : null;
    const lead = st.context
      .slice(shared)
      .filter((c) => !c.claim && (sectionLine == null || c.line !== sectionLine))
      .map((c) => c.text)
      .join(' – ');
    hint.lead = lead || null;
  }
  const body = official.length ? renderOutline(official, (st) => [...st.kept], turn, blocks) : '';

  const extraIndex = new Map(extras.map((e, i) => [e.uri, i]));

  // A colon only reads right with something after it.
  const closed = (text, open) => (open ? text : text.replace(/:$/, '.'));
  return {
    body,
    // Text that no source at all can be traced to is the search model's own knowledge.
    unlisted: placed.some((st) => st.extra.length)
      ? renderOutline(placed, (st) => st.extra.map((uri) => extraIndex.get(uri)), turn)
      : '',
    hints: shownHints.map(({ topic, text, sources, items, section, lead }) => ({
      topic,
      text: closed(text, items.length > 0),
      sources,
      section,
      ...(lead ? { lead } : {}),
      ...(items.length
        ? {
            items: items.map((item, i) => ({
              text: closed(item.text, i < items.length - 1),
              sources: item.sources,
            })),
          }
        : {}),
    })),
  };
}

function formatEntry(entry) {
  return [`[${entry.domain}](${entry.uri})`, entry.jahr, entry.beschreibung]
    .filter(Boolean)
    .join(' · ');
}

/** The source list as LibreChat citation data: only the domain and link Google returned, so a chip
 * reads `awmf.org` and never carries model-written year or description. A source off the list
 * keeps its chip but stays out of the sources block. */
function toOrganicSources(entries, { listed = true, from = 0 } = {}) {
  return entries.map((entry, i) => ({
    position: from + i + 1,
    link: entry.uri,
    title: entry.domain,
    attribution: entry.domain,
    ...(listed ? {} : { official: false }),
  }));
}

/** The line the agent sets before its disclaimer; the chat shows the hints panel in its place. */
const HINTS_MARKER = '::hinweise';

/** Opens an answer no listed source backs; the chat shows the line as a highlighted note, worded
 * like the hints panel's explanation. */
const UNLISTED_NOTE =
  '::quellenvermerk[Diese Angaben sind nicht durch AWMF, Fachgesellschaften, Behörden (z. B. RKI, BfArM, EMA) oder die Fachinformation belegt. Sie stammen aus anderen Quellen oder lassen sich keiner Quelle zuordnen.]';

/** Backed text and its sources for the agent. Hints never reach it; it only gets the marker for
 * where the panel goes. Without a kept source, the text of the other sources is the answer, led
 * by the note; without that either, only the warning. */
function formatAnswer({ body, entries, dropped, hasHints = false, unlisted = '' }) {
  if (!entries.length) {
    return unlisted
      ? [UNLISTED_NOTE, unlisted].join('\n\n')
      : 'WARNUNG: Diese Antwort ist nicht durch eine Websuche belegt.';
  }
  const marker = hasHints ? [HINTS_MARKER] : [];
  const parts = [
    body,
    ...marker,
    ['Quellen:', ...entries.map((e, i) => `${i + 1}. ${formatEntry(e)}`)].join('\n'),
  ];

  if (dropped.length) {
    const one = dropped.length === 1;
    parts.push(
      `Hinweis: ${dropped.length} zitierte ${one ? 'Quelle wurde' : 'Quellen wurden'} entfernt, ` +
        `weil sie nicht in den Suchergebnissen enthalten ${one ? 'war' : 'waren'}.`,
    );
  }

  return parts.join('\n\n');
}

module.exports = {
  parsePolicyConfig,
  buildGroundingPrompt,
  resultDomains,
  parseSourceBlock,
  mergeSources,
  splitAnswer,
  formatAnswer,
  toOrganicSources,
  HINTS_MARKER,
};
