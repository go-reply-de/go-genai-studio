const GoogleVertexAI = require('../structured/GoogleVertexAI');
const WebGroundingEnterprise = require('../structured/WebGroundingEnterprise');
const { loadAuthValues } = require('~/server/services/Tools/credentials');

const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/**
 * Constructors for the Vertex AI tools, spread into `loadTools`' `customConstructors`.
 * @param {object} params
 * @param {string} params.user
 * @param {Pick<Agent, 'model'>} [params.agent]
 * @param {LoadToolOptions} params.options
 * @param {(toolKey: string) => string[]} params.getAuthFields
 */
function vertexToolConstructors({ user, agent, options, getAuthFields }) {
  return {
    vertex_ai_search: async () => {
      const authFields = getAuthFields('vertex_ai_search');
      const authValues = await loadAuthValues({ userId: user, authFields });
      return new GoogleVertexAI({
        ...authValues,
        isAgent: !!agent,
        geminiModel: agent?.model || DEFAULT_GEMINI_MODEL,
      });
    },
    web_grounding_enterprise: async () =>
      new WebGroundingEnterprise({
        geminiModel: agent?.model || DEFAULT_GEMINI_MODEL,
        req: options.req,
        userId: user,
      }),
  };
}

module.exports = { vertexToolConstructors };
