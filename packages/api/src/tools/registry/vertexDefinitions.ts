import type { ExtendedJsonSchema } from './schema';

/** Web Grounding Enterprise tool JSON schema */
export const webGroundingEnterpriseSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search word or phrase for the Web Grounding Enterprise tool',
    },
    medical: {
      type: 'boolean',
      description:
        'Set to false only when the question has no connection to medicine, health or care; the search ' +
        'then skips the medical guideline focus. Leave it out when unsure.',
    },
  },
  required: ['query'],
};

/** Vertex AI Search tool JSON schema */
export const vertexAISearchSchema: ExtendedJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search word or phrase to Vertex AI Search',
    },
  },
  required: ['query'],
};

/** Registry entries for the Vertex AI tools; `toolDefinitions` checks their shape where it spreads them. */
export const vertexToolDefinitions = {
  web_grounding_enterprise: {
    name: 'web_grounding_enterprise',
    description:
      "Use the GDPR-compliant 'web_grounding_enterprise' tool to retrieve search results from the web.",
    schema: webGroundingEnterpriseSchema,
    toolType: 'builtin' as const,
  },
  vertex_ai_search: {
    name: 'vertex_ai_search',
    description:
      "Use the 'vertex_ai_search' tool to retrieve search results from a Vertex AI Search data store relevant to your input.",
    schema: vertexAISearchSchema,
    toolType: 'builtin' as const,
  },
};
