/** Source policy for web_grounding_enterprise: its prompt, how the model's source
 * list is checked against the real search results, and how the answer is rendered. */

const SOURCE_BLOCK_MARKER = '[[QUELLEN]]';

/** Institutions whose identity is a fact rather than a judgement. */
const DEFAULT_VERIFIED_DOMAINS = [
  'awmf.org',
  'leitlinien.de',
  'g-ba.de',
  'iqwig.de',
  'rki.de',
  'bfarm.de',
  'pei.de',
  'ema.europa.eu',
  'nice.org.uk',
  'cochranelibrary.com',
];

/** Never citable. A missing entry is harmless: unlisted junk is still shown as unverified. */
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

function isVerified(domain, verifiedDomains) {
  const host = normalizeDomain(domain);
  return (
    Boolean(host) &&
    (verifiedDomains ?? []).some((listed) => domainMatches(host, normalizeDomain(listed)))
  );
}

function domainList(value, field) {
  if (!Array.isArray(value) || value.some((d) => typeof d !== 'string' || !d.trim())) {
    throw new Error(`Grounding source config: "${field}" must be a list of domains.`);
  }
  return value.map(normalizeDomain);
}

/** Fails loudly rather than running on a policy nobody wrote. A `tiers` config lists
 * the institutions an administrator vouches for, which is the verified register. */
function parsePolicyConfig(raw) {
  if (!raw) {
    return { verifiedDomains: DEFAULT_VERIFIED_DOMAINS, excludeDomains: DEFAULT_EXCLUDE_DOMAINS };
  }

  let verifiedDomains = DEFAULT_VERIFIED_DOMAINS;
  if (raw.verifiedDomains !== undefined) {
    verifiedDomains = domainList(raw.verifiedDomains, 'verifiedDomains');
  } else if (Array.isArray(raw.tiers)) {
    verifiedDomains = raw.tiers.flatMap((tier) => {
      if (!Array.isArray(tier?.domains) || !tier.domains.length) {
        throw new Error(`Grounding source tier "${tier?.name ?? '?'}" lists no domains.`);
      }
      return domainList(tier.domains, `tiers.${tier.name}`);
    });
  }

  const excludeDomains =
    raw.excludeDomains === undefined
      ? DEFAULT_EXCLUDE_DOMAINS
      : domainList(raw.excludeDomains, 'excludeDomains');

  return { verifiedDomains, excludeDomains };
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

const verifiedFirst = (list) => [
  ...list.filter((e) => e.verified),
  ...list.filter((e) => !e.verified),
];

/** A named source the search never returned is dropped as fabricated; an unnamed result
 * stays only if the answer is attributed to it. Verification uses Google's domain. */
function mergeSources({ sources, chunks, supports, verifiedDomains }) {
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
      verified: isVerified(fresh.domain, verifiedDomains),
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
    unnamed.push({
      domain: r.domain,
      uri: r.uri,
      jahr: null,
      beschreibung: null,
      verified: isVerified(r.domain, verifiedDomains),
    });
  }

  const entries = [...verifiedFirst(named), ...verifiedFirst(unnamed)];
  const numbering = new Map([...entryOf].map(([n, e]) => [n, e ? entries.indexOf(e) + 1 : null]));
  return { entries, dropped, numbering };
}

/** Rewrites `[n]` markers to the kept numbering. A bracket is left alone unless every
 * number in it is a source number, so `[2023]` survives. */
function renumberCitations(body, numbering) {
  return String(body ?? '').replace(/\s*\[(\d+(?:\s*,\s*\d+)*)\]/g, (match, list) => {
    const numbers = list.split(',').map((n) => Number.parseInt(n, 10));
    if (!numbers.every((n) => numbering.has(n))) {
      return match;
    }
    const kept = [...new Set(numbers.map((n) => numbering.get(n)).filter((n) => n !== null))];
    if (!kept.length) {
      return '';
    }
    return `${match.match(/^\s*/)[0]}[${kept.join(', ')}]`;
  });
}

function describeEntry(entry) {
  return [entry.verified ? 'verifiziert' : 'nicht verifiziert', entry.jahr, entry.beschreibung]
    .filter(Boolean)
    .join(' · ');
}

function formatEntry(entry) {
  return `[${entry.domain}](${entry.uri}) · ${describeEntry(entry)}`;
}

/** The answer's source list as LibreChat Sources-panel items, numbered like the text. */
function toOrganicSources(entries) {
  return entries.map((entry, i) => ({
    position: i + 1,
    link: entry.uri,
    title: entry.domain,
    attribution: entry.domain,
    snippet: describeEntry(entry),
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

  const notes = [];
  if (entries.length && !entries.some((e) => e.verified)) {
    notes.push(
      'Hinweis: Keine Quelle aus dem verifizierten Register; die Quellen sind nicht geprüft.',
    );
  }
  if (dropped.length) {
    const one = dropped.length === 1;
    notes.push(
      `Hinweis: ${dropped.length} zitierte ${one ? 'Quelle wurde' : 'Quellen wurden'} entfernt, ` +
        `weil sie nicht in den Suchergebnissen enthalten ${one ? 'war' : 'waren'}.`,
    );
  }
  if (notes.length) {
    parts.push(notes.join('\n'));
  }

  return parts.join('\n\n');
}

module.exports = {
  isVerified,
  parsePolicyConfig,
  buildGroundingPrompt,
  resultDomains,
  parseSourceBlock,
  mergeSources,
  renumberCitations,
  formatAnswer,
  toOrganicSources,
};
