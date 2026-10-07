import { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import { applyWeeklyRetention } from '~/models/plugins/weeklyRetention';
import transactionSchema, { ITransaction } from '~/schema/transaction';

export function createTransactionModel(mongoose: typeof import('mongoose')): Model<ITransaction> {
  applyTenantIsolation(transactionSchema);
  applyWeeklyRetention(transactionSchema);
  return (
    mongoose.models.Transaction || mongoose.model<ITransaction>('Transaction', transactionSchema)
  );
}
