import { Model } from 'mongoose';
import type { IChatProjectDocument } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import { applyWeeklyRetention } from '~/models/plugins/weeklyRetention';
import chatProjectSchema from '~/schema/chatProject';

export function createChatProjectModel(
  mongoose: typeof import('mongoose'),
): Model<IChatProjectDocument> {
  applyTenantIsolation(chatProjectSchema);
  applyWeeklyRetention(chatProjectSchema);
  return (
    mongoose.models.ChatProject ||
    mongoose.model<IChatProjectDocument>('ChatProject', chatProjectSchema, 'chatprojects')
  );
}
