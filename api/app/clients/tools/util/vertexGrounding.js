const { logger } = require('@librechat/data-schemas');

const MAX_OUTPUT_CHARS = 8000;

/**
 * Extracts the answer text and grounding citations from a raw
 * `@google-cloud/vertexai` `GenerateContentResponse`, rather than
 * returning the full envelope (safety ratings, base64 search blobs,
 * usage metadata) which is noisy and hard for a calling LLM to parse.
 *
 * Grounding chunks come back as either `web` (Google/enterprise web search)
 * or `retrievedContext` (Vertex AI Search data store retrieval) depending
 * on which grounding tool produced them.
 */
function formatGroundingResponse(response) {
    const candidate = response?.candidates?.[0];
    if (!candidate) {
        return 'No grounded response was returned for this query.';
    }

    const text = (candidate.content?.parts ?? [])
        .map((part) => part.text)
        .filter(Boolean)
        .join('\n')
        .trim();

    const groundingChunks = candidate.groundingMetadata?.groundingChunks ?? [];
    const sources = groundingChunks
        .map((chunk) => chunk.web ?? chunk.retrievedContext)
        .filter((source) => source?.uri);

    logger.debug(
        `[formatGroundingResponse] groundingChunks: ${groundingChunks.length}, sources with uri: ${sources.length}, webSearchQueries: ${candidate.groundingMetadata?.webSearchQueries?.length ?? 0}, retrievalQueries: ${candidate.groundingMetadata?.retrievalQueries?.length ?? 0}`,
    );

    const uniqueSources = [...new Map(sources.map((source) => [source.uri, source])).values()];

    const sourcesBlock = uniqueSources.length
        ? '\n\nSources:\n' +
          uniqueSources.map((source, i) => `${i + 1}. ${source.title || source.uri} - ${source.uri}`).join('\n')
        : '';

    const result = `${text || 'No answer text was returned for this query.'}${sourcesBlock}`;
    return result.length > MAX_OUTPUT_CHARS ? `${result.slice(0, MAX_OUTPUT_CHARS)}...` : result;
}

module.exports = { formatGroundingResponse };
