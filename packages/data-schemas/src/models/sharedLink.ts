import { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import { applyWeeklyRetention } from '~/models/plugins/weeklyRetention';
import shareSchema, { ISharedLink } from '~/schema/share';

export function createSharedLinkModel(mongoose: typeof import('mongoose')): Model<ISharedLink> {
  applyTenantIsolation(shareSchema);
  applyWeeklyRetention(shareSchema);
  return mongoose.models.SharedLink || mongoose.model<ISharedLink>('SharedLink', shareSchema);
}
