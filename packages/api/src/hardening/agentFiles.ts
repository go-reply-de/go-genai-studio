import mongoose from 'mongoose';
import { EToolResources } from 'librechat-data-provider';

/** Tool resources whose files belong to an agent rather than to a single chat. */
const TOOL_RESOURCE_KEYS = [
  EToolResources.execute_code,
  EToolResources.file_search,
  EToolResources.image_edit,
  EToolResources.context,
  EToolResources.ocr,
] as const;

type AgentFileRefs = {
  tool_resources?: Partial<
    Record<(typeof TOOL_RESOURCE_KEYS)[number], { file_ids?: string[] | null } | null>
  >;
};

/**
 * The ids among `fileIds` that some agent lists in its tool resources. Throws when the agent
 * model is missing, so a caller deciding what to delete keeps everything instead.
 */
export async function findAgentFileIds(fileIds: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (fileIds.length === 0) {
    return found;
  }
  const Agent = mongoose.models.Agent;
  if (Agent == null) {
    throw new Error('Agent model is not registered');
  }

  const requested = new Set(fileIds);
  const agents = await Agent.find(
    {
      $or: TOOL_RESOURCE_KEYS.map((key) => ({
        [`tool_resources.${key}.file_ids`]: { $in: fileIds },
      })),
    },
    { tool_resources: 1 },
  ).lean<AgentFileRefs[]>();

  for (const agent of agents) {
    for (const key of TOOL_RESOURCE_KEYS) {
      for (const fileId of agent.tool_resources?.[key]?.file_ids ?? []) {
        if (requested.has(fileId)) {
          found.add(fileId);
        }
      }
    }
  }
  return found;
}
