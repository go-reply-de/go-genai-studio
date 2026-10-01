const { extractGroundingResponse } = require('./vertexGrounding');

describe('extractGroundingResponse', () => {
  test('pulls text, chunks and supports out of the candidate envelope', () => {
    const response = {
      candidates: [
        {
          content: { parts: [{ text: 'Amoxicillin' }, { text: 'ist Mittel der Wahl.' }] },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: 'stub-1', domain: 'awmf.org' } }],
            groundingSupports: [{ groundingChunkIndices: [0], segment: { text: 'Amoxicillin' } }],
          },
        },
      ],
    };

    const out = extractGroundingResponse(response);

    expect(out.text).toBe('Amoxicillin\nist Mittel der Wahl.');
    expect(out.chunks).toHaveLength(1);
    expect(out.supports).toHaveLength(1);
  });

  test('returns empty collections when the model produced no candidate', () => {
    const out = extractGroundingResponse({ candidates: [] });

    expect(out).toEqual({ text: '', chunks: [], supports: [] });
  });
});
