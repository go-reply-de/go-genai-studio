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
  return { entries, dropped, numbering, unlisted };
}

const CITATION_MARKER = /\s*\[(\d+(?:\s*,\s*\d+)*)\]/g;
const LEADING_MARKER = /^\s*\[\d+(?:\s*,\s*\d+)*\]/;
const TRAILING_PUNCTUATION = /[.,;:!?)»"”]/;

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

/** Nested spans citing one source collapse into their outermost end. */
function mergedEnds(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
  const ends = [];
  let current = null;
  for (const range of sorted) {
    if (current && range.start < current.end) {
      current.end = Math.max(current.end, range.end);
      continue;
    }
    current = { ...range };
    ends.push(current);
  }
  return ends.map((range) => range.end);
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

/** An anchor goes after the model's own marker and the sentence's punctuation. */
function snapPast(text, position, limit) {
  let at = position;
  for (;;) {
    const marker = LEADING_MARKER.exec(text.slice(at, limit));
    if (marker) {
      at += marker[0].length;
    } else if (at < limit && TRAILING_PUNCTUATION.test(text[at])) {
      at += 1;
    } else {
      return at;
    }
  }
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

/** Where Google says each kept source backs the answer, and those passages merged; a passage runs
 * up to where its anchor goes. */
function backedPassages({ raw, bodyEnd, supports, chunks, entries }) {
  const entryOfChunk = (chunks ?? []).map((c) =>
    entries.findIndex((e) => e.uri === (c.web ?? c.retrievedContext ?? {}).uri),
  );
  const rangesByEntry = new Map();
  for (const support of supports ?? []) {
    const range = segmentRange(raw, support.segment);
    if (!range || range.end > bodyEnd) {
      continue;
    }
    for (const chunkIndex of support.groundingChunkIndices ?? []) {
      const entryIndex = entryOfChunk[chunkIndex];
      if (entryIndex == null || entryIndex < 0) {
        continue;
      }
      rangesByEntry.set(entryIndex, [...(rangesByEntry.get(entryIndex) ?? []), range]);
    }
  }
  const kept = mergedRanges(
    [...rangesByEntry.values()]
      .flat()
      .map((r) => ({ start: r.start, end: snapPast(raw, r.end, bodyEnd) })),
  );
  return { rangesByEntry, kept };
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

/** The answer body with a LibreChat citation anchor behind every passage Google attributes to a
 * kept source, numbered like the source list; the model's own `[n]` markers are dropped. With
 * `cut`, only those passages remain, so nothing an unlisted source contributed reaches the agent. */
function anchorClaims({ text, supports, chunks, entries, numbering, turn = 0, cut = false }) {
  const raw = String(text ?? '');
  const bodyEnd = bodyEndOf(raw);
  const backed = backedPassages({ raw, bodyEnd, supports, chunks, entries });
  const { rangesByEntry } = backed;

  const anchorsAt = new Map();
  for (const [entryIndex, ranges] of rangesByEntry) {
    for (const end of mergedEnds(ranges)) {
      const at = snapPast(raw, end, bodyEnd);
      anchorsAt.set(at, (anchorsAt.get(at) ?? new Set()).add(entryIndex));
    }
  }

  const markers = citationMarkers(raw, bodyEnd, numbering);
  // Without `cut` the whole body is one passage.
  const kept = cut ? backed.kept : [{ start: 0, end: bodyEnd }];
  const passageAt = (i, withEnd) =>
    kept.findIndex((r) => i >= r.start && (withEnd ? i <= r.end : i < r.end));

  let out = '';
  let lastPassage = -1;
  for (let i = 0; i <= bodyEnd; ) {
    if (anchorsAt.has(i) && passageAt(i, true) >= 0) {
      const before = out && !/\s$/.test(out) ? ' ' : '';
      const after = i < bodyEnd && !/\s/.test(raw[i]) ? ' ' : '';
      out += `${before}${anchorFor(anchorsAt.get(i), turn)}${after}`;
    }
    if (markers.has(i)) {
      i = markers.get(i);
      continue;
    }
    const passage = i < bodyEnd ? passageAt(i, false) : -1;
    if (passage >= 0) {
      if (lastPassage >= 0 && passage !== lastPassage) {
        const gap = raw.slice(kept[lastPassage].end, kept[passage].start);
        out = out.trimEnd() + (gap.includes('\n') ? '\n' : ' ');
      }
      out += raw[i];
      lastPassage = passage;
    }
    i += 1;
  }
  return out.trim();
}

const ABBREVIATION =
  /(?:^|[\s(])(?:z|u|d|o|s|ca|bzw|ggf|evtl|inkl|vgl|sog|Dr|Prof|Nr|Abb|Tab|max|min|mind|i\.v|p\.o|s\.c|i\.m|z\. ?B|d\. ?h|u\. ?a)$/i;

/** Sentence offsets within a line: a break is a sentence end followed by a capital, but not after
 * `z. B.`, `ggf.`, `i.v.` and the like. */
function sentenceSpans(line) {
  const spans = [];
  let start = 0;
  for (const m of line.matchAll(/[.!?]\s+(?=\p{Lu})/gu)) {
    if (ABBREVIATION.test(line.slice(start, m.index))) {
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

/** Every sentence no kept source backs any part of, as plain statements for the agent's hints
 * section; a partly backed sentence already lives in the backed text. Markup, the model's `[n]`
 * markers, headings and labels go, and so does every sentence with a dose. */
function unbackedStatements({ text, supports, chunks, entries, numbering }) {
  const raw = String(text ?? '');
  const bodyEnd = bodyEndOf(raw);
  const { kept } = backedPassages({ raw, bodyEnd, supports, chunks, entries });
  const markers = citationMarkers(raw, bodyEnd, numbering);
  const backed = (from, to) => kept.some((range) => range.start < to && range.end > from);
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
    return out
      .replace(/^\s*(?:[-*•]|\d+\.)\s+/, '')
      .replace(/\*\*|__/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const statements = [];
  let lineStart = 0;
  for (const line of raw.slice(0, bodyEnd).split('\n')) {
    if (!/^\s*#/.test(line)) {
      const statement = sentenceSpans(line)
        .map(([from, to]) => [lineStart + from, lineStart + to])
        .filter(([from, to]) => !backed(from, to))
        .map(([from, to]) => plain(from, to))
        .filter((sentence) => sentence && !DOSE.test(sentence))
        .join(' ');
      if (statement.length >= 12 && !statement.endsWith(':') && /^[\p{Lu}\d„"(]/u.test(statement)) {
        statements.push(statement);
      }
    }
    lineStart += line.length + 1;
  }
  return statements;
}

function formatEntry(entry) {
  return [`[${entry.domain}](${entry.uri})`, entry.jahr, entry.beschreibung]
    .filter(Boolean)
    .join(' · ');
}

/** The source list as LibreChat citation data: only the domain and link Google returned, so a chip
 * reads `awmf.org` and never carries model-written year or description. */
function toOrganicSources(entries) {
  return entries.map((entry, i) => ({
    position: i + 1,
    link: entry.uri,
    title: entry.domain,
    attribution: entry.domain,
  }));
}

const UNOFFICIAL_HEADING =
  'Ergänzende Hinweise ohne offizielle Quelle – bitte eigenständig prüfen:';

/** Backed text with its sources, then what no kept source backs under its own heading, never with
 * a source name. Without a kept source the warning leads. */
function formatAnswer({ body, entries, dropped, unofficial = [] }) {
  const hints = unofficial.length
    ? [[UNOFFICIAL_HEADING, ...unofficial.map((statement) => `- ${statement}`)].join('\n')]
    : [];
  if (!entries.length) {
    return ['WARNUNG: Diese Antwort ist nicht durch eine Websuche belegt.', ...hints].join('\n\n');
  }
  const parts = [
    body,
    ...hints,
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
  anchorClaims,
  unbackedStatements,
  formatAnswer,
  toOrganicSources,
};
