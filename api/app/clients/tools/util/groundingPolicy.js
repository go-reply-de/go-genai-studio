/**
 * Source policy for the web_grounding_enterprise tool: which domains are
 * acceptable, in what order they are tried, and how a grounded response is
 * turned into an attributed answer.
 */

/** Label-aware suffix match, so `nih.gov` covers `pubmed.ncbi.nlm.nih.gov`. */
function isDomainInTier(domain, tier) {
  if (!domain) {
    return false;
  }
  return (tier.domains ?? []).some((listed) => domain === listed || domain.endsWith(`.${listed}`));
}

/** Grounding chunks arrive as either `web` or `retrievedContext`. */
function normalizeChunk(chunk, index) {
  const source = chunk.web ?? chunk.retrievedContext ?? {};
  return { index, uri: source.uri, domain: source.domain, title: source.title };
}

function partitionChunks(chunks, tier) {
  const inTier = [];
  const offTier = [];
  (chunks ?? []).forEach((chunk, index) => {
    const normalized = normalizeChunk(chunk, index);
    (isDomainInTier(normalized.domain ?? '', tier) ? inTier : offTier).push(normalized);
  });
  return { inTier, offTier };
}

/**
 * Keeps the claims an approved source stands behind. A claim citing both an
 * approved and an unapproved chunk is kept but attributed only to the approved
 * one, since dropping it would discard content the tier does support.
 */
function attributeClaims(supports, allowedIndices) {
  const allowed = new Set(allowedIndices);
  const claims = [];
  for (const support of supports ?? []) {
    const cited = (support.groundingChunkIndices ?? []).filter((i) => allowed.has(i));
    if (!cited.length) {
      continue;
    }
    claims.push({
      text: support.segment?.text ?? '',
      startIndex: support.segment?.startIndex,
      endIndex: support.segment?.endIndex,
      chunkIndices: cited,
    });
  }
  return claims;
}

/** What a tier is told to reply when it finds nothing, so a miss is explicit. */
const NO_SOURCE_SENTINEL = 'NO_SOURCE_IN_SCOPE';

function evaluateTier(response, tier) {
  const { text = '', chunks = [], supports = [] } = response ?? {};
  if (text.trim().startsWith(NO_SOURCE_SENTINEL)) {
    return { hit: false, tier, text, claims: [], sources: [], offTierDomains: [] };
  }
  const { inTier, offTier } = partitionChunks(chunks, tier);
  const claims = attributeClaims(
    supports,
    inTier.map((c) => c.index),
  );
  return {
    hit: inTier.length > 0 && claims.length > 0,
    tier,
    text,
    claims,
    sources: inTier,
    offTierDomains: [...new Set(offTier.map((c) => c.domain).filter(Boolean))],
  };
}

/**
 * Steers the search at one tier. The steering is advisory - correctness comes
 * from checking the domains that actually come back - but it raises the hit
 * rate and gives the model an explicit way to report an empty tier.
 */
function buildTierQuery(query, tier) {
  const domains = (tier.domains ?? []).join(', ');
  return [
    `Answer using only sources from these domains: ${domains}.`,
    `If they hold nothing relevant, reply with exactly ${NO_SOURCE_SENTINEL} and nothing else.`,
    '',
    query,
  ].join('\n');
}

/**
 * Validates the mounted tier config. An empty or malformed tier would answer
 * every question with "no approved source", so it fails here instead.
 */
function parseTierConfig(raw) {
  const tiers = raw?.tiers;
  if (!Array.isArray(tiers) || !tiers.length) {
    throw new Error('Grounding source config has no tiers.');
  }
  for (const tier of tiers) {
    if (!tier.name) {
      throw new Error('Grounding source config has a tier without a name.');
    }
    if (!Array.isArray(tier.domains) || !tier.domains.length) {
      throw new Error(`Grounding source tier "${tier.name}" lists no domains.`);
    }
  }
  return tiers;
}

/**
 * Grounding segment offsets are UTF-8 byte positions, not JS string indices,
 * so any answer containing an umlaut shifts them. Measured against a live
 * response: byte 135 was character 134.
 */
function byteToCharIndex(text, byteIndex) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (byteIndex >= bytes) {
    return text.length;
  }
  return Buffer.from(text, 'utf8').subarray(0, byteIndex).toString('utf8').length;
}

/**
 * Abbreviations whose periods Intl.Segmenter would read as sentence ends. It
 * already handles a lowercase continuation such as `p. o.`, but not a capital
 * one such as `z. B.`, which is common in German clinical text.
 */
const ABBREVIATIONS =
  /\b(z\. ?B|d\. ?h|u\. ?a|s\. ?o|s\. ?u|i\. ?v|p\. ?o|bzw|ggf|ca|inkl|evtl|Nr|Abb|Tab|vgl|max|min)\./g;

/**
 * Where a citation marker belongs in each sentence: just before the closing
 * punctuation, so the text reads "... der Wahl [1]." rather than "... [1]".
 */
function citationPoints(text) {
  // Same-length substitution, so every index still refers to the original text.
  // A private-use character, because U+2024 is itself a sentence terminator.
  const masked = text.replace(ABBREVIATIONS, (m) => m.replace(/\./g, '\uE000'));
  const segmenter = new Intl.Segmenter('de', { granularity: 'sentence' });

  const points = [];
  for (const { segment, index } of segmenter.segment(masked)) {
    let end = index + segment.length;
    while (end > index && /[\s.!?;:]/.test(masked[end - 1])) {
      end -= 1;
    }
    if (end > index) {
      points.push(end);
    }
  }
  return points;
}

/**
 * The parts of the answer an approved source stands behind, taken from the
 * original text by merged character range. Joining the spans' own texts would
 * duplicate content, because grounding spans nest inside one another.
 */
function supportedText(text, claims) {
  const ranges = (claims ?? [])
    .filter((c) => typeof c.startIndex === 'number' && typeof c.endIndex === 'number')
    .map((c) => [byteToCharIndex(text, c.startIndex), byteToCharIndex(text, c.endIndex)])
    .sort((a, b) => a[0] - b[0]);

  // Without offsets, fall back to the spans' own texts, dropping any span
  // wholly contained in another so nesting still cannot duplicate content.
  if (!ranges.length) {
    const texts = (claims ?? []).map((c) => c.text).filter(Boolean);
    return texts
      .filter((t, i) => !texts.some((other, j) => j !== i && other.includes(t) && other !== t))
      .filter((t, i, list) => list.indexOf(t) === i)
      .join(' ');
  }

  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged
    .map(([start, end]) => text.slice(start, end).trim())
    .filter(Boolean)
    .join(' ');
}

/** Numbers the sources the way formatSources lists them: one per document. */
function sourceNumbers(sources) {
  const numbers = new Map();
  const uris = [];
  for (const source of sources) {
    if (!uris.includes(source.uri)) {
      uris.push(source.uri);
    }
    numbers.set(source.index, uris.indexOf(source.uri) + 1);
  }
  return { numbers, count: uris.length };
}

/**
 * Puts each claim's citation at the end of the sentence it falls in, rather
 * than at the raw span end - grounding spans stop mid-phrase and sometimes
 * inside markdown emphasis, where a marker would corrupt the formatting.
 */
function annotateInline(text, claims, sources) {
  const { numbers, count } = sourceNumbers(sources ?? []);
  // With one source every marker would read [1]; the source line says it once.
  if (count < 2) {
    return text;
  }

  const points = citationPoints(text);
  const byPoint = new Map();
  for (const claim of claims ?? []) {
    if (typeof claim.endIndex !== 'number') {
      continue;
    }
    const charEnd = byteToCharIndex(text, claim.endIndex);
    // A span ending at the very end of the text sits past the last boundary,
    // which is before the closing punctuation - cite the final sentence.
    const point = points.find((p) => p >= charEnd) ?? points[points.length - 1];
    if (point === undefined) {
      continue;
    }
    const cited = byPoint.get(point) ?? new Set();
    claim.chunkIndices.forEach((i) => numbers.has(i) && cited.add(numbers.get(i)));
    byPoint.set(point, cited);
  }

  // Back to front, so earlier insertion points keep their indices.
  let annotated = text;
  for (const point of [...byPoint.keys()].sort((a, b) => b - a)) {
    const marker = [...byPoint.get(point)]
      .sort((a, b) => a - b)
      .map((n) => `[${n}]`)
      .join('');
    annotated = `${annotated.slice(0, point)} ${marker}${annotated.slice(point)}`;
  }
  return annotated;
}

/**
 * One prompt covering every approved domain, preferred tier first. Trades the
 * forced tier-by-tier search for a single call; priority is then enforced by
 * ranking what comes back rather than by the order of the searches.
 */
function buildRankedQuery(query, tiers) {
  const preference = (tiers ?? []).map(
    (tier, i) => `${i + 1}. ${tier.name}: ${(tier.domains ?? []).join(', ')}`,
  );
  return [
    'Answer using only sources from the domains listed below, preferring those',
    'higher in the list. Use a lower group only where the ones above hold nothing.',
    ...preference,
    `If none of them hold anything relevant, reply with exactly ${NO_SOURCE_SENTINEL} and nothing else.`,
    '',
    query,
  ].join('\n');
}

/** The highest-priority tier that the single response actually supports. */
function rankResponse(response, tiers) {
  for (const tier of tiers ?? []) {
    const result = evaluateTier(response, tier);
    if (result.hit) {
      return result;
    }
  }
  return { hit: false, tier: null, text: '', claims: [], sources: [], offTierDomains: [] };
}

/**
 * Tries each tier in order and returns the first that a source actually backs.
 * `ask` performs one grounding call; injecting it keeps the ordering logic
 * testable without a live Vertex client.
 *
 * Every configured tier is tried unless `maxTiers` caps it - silently skipping
 * a tier an administrator listed would be worse than the extra latency.
 */
async function runCascade({ tiers, ask, maxTiers }) {
  for (const tier of (tiers ?? []).slice(0, maxTiers ?? undefined)) {
    const result = evaluateTier(await ask(tier), tier);
    if (result.hit) {
      return result;
    }
  }
  return { hit: false, tier: null, text: '', claims: [], sources: [], offTierDomains: [] };
}

const NO_APPROVED_SOURCE =
  'No approved source was found for this question. The configured source tiers ' +
  'returned nothing relevant, so no answer is given rather than one drawn from ' +
  'an unapproved source.';

/**
 * `web.title` only ever carries the domain, so a source line shows the domain
 * and links the redirect stub - the identifier itself is quoted by the model
 * inside the answer text.
 */
function formatSources(sources, tier) {
  const seen = new Map(sources.map((source) => [source.uri, source]));
  const unique = [...seen.values()];
  // Written as a complete markdown link so the calling model can copy the
  // string verbatim rather than joining a label to a separate definition.
  const lines = unique.map((source, i) => `${i + 1}. [${source.domain}](${source.uri})`);
  return [`Sources (${tier?.name ?? 'approved'}):`, ...lines].join('\n');
}

function formatAnswer(result) {
  if (!result?.hit) {
    return NO_APPROVED_SOURCE;
  }
  // Off-tier chunks mean the text was written partly from sources we reject, so
  // only the claims an approved source stands behind are kept.
  const body = result.offTierDomains?.length
    ? supportedText(result.text, result.claims)
    : result.text;
  const cited = annotateInline(body, result.claims, result.sources ?? []);
  return `${cited}\n\n${formatSources(result.sources ?? [], result.tier)}`;
}

module.exports = {
  NO_SOURCE_SENTINEL,
  isDomainInTier,
  partitionChunks,
  attributeClaims,
  evaluateTier,
  runCascade,
  buildTierQuery,
  formatAnswer,
  parseTierConfig,
  byteToCharIndex,
  citationPoints,
  annotateInline,
  supportedText,
  buildRankedQuery,
  rankResponse,
};
