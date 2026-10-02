import { runAsSystem } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { Application } from 'express';
import type { CappedRole, RolePermissionCapMethods } from './caps';
import type { StartupConfigFlags } from './config';
import { createStrictBrowserEgress, isStrictBrowserEgress } from './egress';
import { createSpeechAccessGate, isSpeechLocalOnly } from './speech';
import { startRetentionMaintenance } from '~/retention';
import { createStartupConfigFlags } from './config';
import { applyRolePermissionCaps } from './caps';
import { deleteRagFile } from '~/files/rag';
import { isLeader } from '~/cluster';

/** The app's database methods the hardening reads roles, files and agent references through. */
export interface HardeningMethods<R extends CappedRole = CappedRole>
  extends RolePermissionCapMethods<R> {
  getFiles: (
    filter: { file_id: { $in: string[] } },
    sortOptions: null,
    selectFields: { file_id: 1 },
  ) => Promise<Array<{ file_id: string }> | null>;
  getSharedResourceFileIds: (params: { file_ids: string[] }) => Promise<string[]>;
}

export interface HardeningOptions<R extends CappedRole = CappedRole> {
  app: Application;
  appConfig?: AppConfig;
  methods: HardeningMethods<R>;
}

/**
 * Registers the deployment hardening ahead of the routers. Every piece stays off until its env
 * is set: STRICT_BROWSER_EGRESS, SPEECH_LOCAL_ONLY, ROLE_PERMISSION_CAPS and
 * RETENTION_WEEKLY_RESET.
 */
export async function startHardening<R extends CappedRole>({
  app,
  appConfig,
  methods,
}: HardeningOptions<R>): Promise<void> {
  const strictBrowserEgress = isStrictBrowserEgress();
  const speechLocalOnly = isSpeechLocalOnly();
  if (strictBrowserEgress) {
    app.use(createStrictBrowserEgress());
  }
  if (speechLocalOnly) {
    app.use('/api/files/speech', createSpeechAccessGate());
  }

  const flags: StartupConfigFlags = {
    ...(strictBrowserEgress && { strictBrowserEgress: true }),
    ...(speechLocalOnly && { speechLocalOnly: true }),
  };
  if (Object.keys(flags).length > 0) {
    app.use('/api/config', createStartupConfigFlags(flags));
  }

  await runAsSystem(() => applyRolePermissionCaps(methods));

  const uploadsPath = appConfig?.paths?.uploads;
  const imagesPath = appConfig?.paths?.imageOutput;
  if (uploadsPath == null || imagesPath == null) {
    return;
  }
  startRetentionMaintenance(
    { uploadsPath, imagesPath },
    {
      isLeader,
      now: Date.now,
      findStoredFileIds: async (fileIds) => {
        const files = await runAsSystem(() =>
          methods.getFiles({ file_id: { $in: fileIds } }, null, { file_id: 1 }),
        );
        return new Set((files ?? []).map((file) => file.file_id));
      },
      findAgentFileIds: async (fileIds) =>
        new Set(await runAsSystem(() => methods.getSharedResourceFileIds({ file_ids: fileIds }))),
      deleteVectors: (userId, fileId) =>
        deleteRagFile({ userId, file: { file_id: fileId, embedded: true } }),
    },
  );
}
