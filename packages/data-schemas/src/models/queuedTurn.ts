import type { Model } from 'mongoose';
import type {
  IAgentQueuedTurnDocument,
  IAgentQueuedTurnSequenceDocument,
} from '~/types/queuedTurn';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import { applyWeeklyRetention } from '~/models/plugins/weeklyRetention';
import queuedTurnSequenceSchema from '~/schema/queuedTurnSequence';
import queuedTurnSchema from '~/schema/queuedTurn';

export function createAgentQueuedTurnModel(
  mongoose: typeof import('mongoose'),
): Model<IAgentQueuedTurnDocument> {
  applyTenantIsolation(queuedTurnSchema);
  applyWeeklyRetention(queuedTurnSchema);
  return (
    mongoose.models.AgentQueuedTurn ||
    mongoose.model<IAgentQueuedTurnDocument>('AgentQueuedTurn', queuedTurnSchema)
  );
}

export function createAgentQueuedTurnSequenceModel(
  mongoose: typeof import('mongoose'),
): Model<IAgentQueuedTurnSequenceDocument> {
  applyTenantIsolation(queuedTurnSequenceSchema);
  return (
    mongoose.models.AgentQueuedTurnSequence ||
    mongoose.model<IAgentQueuedTurnSequenceDocument>(
      'AgentQueuedTurnSequence',
      queuedTurnSequenceSchema,
    )
  );
}
