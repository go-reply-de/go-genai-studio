/** Source policy for web_grounding_enterprise: its prompt, how the model's source
 * list is checked against the real search results, and how the answer is rendered. */

const SOURCE_BLOCK_MARKER = '[[QUELLEN]]';

/** Never citable. A missing entry only means that host can still appear as a source. */
const DEFAULT_EXCLUDE_DOMAINS = [
  'gesundheits-lexikon.com',
  'gelenk-klinik.de',
  'knowunity.de',
  'heilpraxisnet.de',
  'zentrum-der-gesundheit.de',
  'symptoma.de',
  'jameda.de',
  'doktorweigl.de',
  'krank.de',
  'medlexi.de',
  'doccheck.com',
  'researchgate.net',
  'proquest.com',
  'wikipedia.org',
  'netdoktor.de',
  'apotheken-umschau.de',
  'onmeda.de',
  'gesundheit.de',
  'pflegeportal.ch',
  'news-papers.eu',
  'anesthesiaservicesla.com',
  'getclarimed.com',
  'medizinio.de',
  'facebook.com',
  'britehealth.com',
  'golighter.de',
  'cme-kurs.de',
  'dguht.de',
  'nerdfallmedizin.de',
  'consu-med.de',
  'medi-know.org',
  'shotsyapp.com',
  'cureal.de',
  'pflege.de',
  'radprax-vorsorge.de',
  'helios-gesundheit.de',
  'idw-online.de',
];

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

/** Only the exclusion list is read from a mounted config; a malformed one fails loudly. */
function parsePolicyConfig(raw) {
  const excludeDomains =
    raw?.excludeDomains === undefined
      ? DEFAULT_EXCLUDE_DOMAINS
      : domainList(raw.excludeDomains, 'excludeDomains');

  return { excludeDomains };
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

/** A named source the search never returned is dropped as fabricated; an unnamed result
 * stays only if the answer is attributed to it. Entries carry Google's domain, not the model's. */
function mergeSources({ sources, chunks, supports }) {
  const results = (chunks ?? [])
    .map((c) => c.web ?? c.retrievedContext ?? {})
    .map((w, index) => ({ domain: normalizeDomain(w.domain), uri: w.uri, index, claimed: false }))
    .filter((r) => HOSTNAME.test(r.domain));
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
    // Prefer an unclaimed result so two pages from one domain keep their own links;
    // with none left, the citation repeats a page that is already listed.
    const fresh = matching.find((r) => !r.claimed);
    if (!fresh) {
      entryOf.set(s.n, named.find((e) => e.uri === matching[0].uri) ?? null);
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
    if (r.claimed || seen.has(r.uri) || !used.has(r.index)) {
      continue;
    }
    seen.add(r.uri);
    unnamed.push({ domain: r.domain, uri: r.uri, jahr: null, beschreibung: null });
  }

  const entries = [...named, ...unnamed];
  const numbering = new Map([...entryOf].map(([n, e]) => [n, e ? entries.indexOf(e) + 1 : null]));
  return { entries, dropped, numbering };
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

/** The answer body with a LibreChat citation anchor behind every passage Google attributes to a
 * kept source, numbered like the source list; the model's own `[n]` markers are dropped. */
function anchorClaims({ text, supports, chunks, entries, numbering, turn = 0 }) {
  const raw = String(text ?? '');
  const blockAt = raw.lastIndexOf(SOURCE_BLOCK_MARKER);
  const bodyEnd = blockAt < 0 ? raw.length : blockAt;
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

  const anchorsAt = new Map();
  for (const [entryIndex, ranges] of rangesByEntry) {
    for (const end of mergedEnds(ranges)) {
      const at = snapPast(raw, end, bodyEnd);
      anchorsAt.set(at, (anchorsAt.get(at) ?? new Set()).add(entryIndex));
    }
  }

  // Same rule as the source numbering: `[2023]` is not a citation.
  const markers = new Map();
  for (const m of raw.slice(0, bodyEnd).matchAll(CITATION_MARKER)) {
    const numbers = m[1].split(',').map((n) => Number.parseInt(n, 10));
    if (numbers.every((n) => numbering?.has(n))) {
      markers.set(m.index, m.index + m[0].length);
    }
  }

  let out = '';
  for (let i = 0; i <= bodyEnd; ) {
    if (anchorsAt.has(i)) {
      const before = out && !/\s$/.test(out) ? ' ' : '';
      const after = i < bodyEnd && !/\s/.test(raw[i]) ? ' ' : '';
      out += `${before}${anchorFor(anchorsAt.get(i), turn)}${after}`;
    }
    if (markers.has(i)) {
      i = markers.get(i);
      continue;
    }
    if (i < bodyEnd) {
      out += raw[i];
    }
    i += 1;
  }
  return out.trim();
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

/** Never refuses: missing evidence is stated, not withheld. */
function formatAnswer({ body, entries, dropped, grounded }) {
  const parts = [];
  if (!grounded) {
    parts.push('WARNUNG: Diese Antwort ist nicht durch eine Websuche belegt.');
  }
  parts.push(body || 'Es wurde kein Antworttext zurückgegeben.');

  if (entries.length) {
    parts.push(['Quellen:', ...entries.map((e, i) => `${i + 1}. ${formatEntry(e)}`)].join('\n'));
  }

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
  formatAnswer,
  toOrganicSources,
};
