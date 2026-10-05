import { logger, getWeeklyReset } from '@librechat/data-schemas';
import type { OrphanUploadDeps } from './orphans';
import { sweepStaleUploads, STALE_UPLOAD_MS } from './uploads';
import { ensureLogsExpiryIndex } from './logs';
import { sweepOrphanUploads } from './orphans';

const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

export interface RetentionMaintenanceOptions {
  /** `paths.uploads`; multer stages uploads in its `temp` folder. */
  uploadsPath: string;
  /** `paths.imageOutput`, where stored images live. */
  imagesPath: string;
}

export interface RetentionMaintenanceDeps extends OrphanUploadDeps {
  isLeader: () => Promise<boolean>;
}

/** File system errors name the path, and with it the uploaded file name, so log neither. */
function safeError(error: unknown): Record<string, unknown> {
  const failure = error as NodeJS.ErrnoException | null;
  return { type: failure?.name ?? 'UnknownError', code: failure?.code };
}

/**
 * Removes what the weekly reset cannot reach through a TTL index: abandoned temp uploads, stored
 * uploads without a files row, and Keyv log entries past their expiry. Inert unless
 * RETENTION_WEEKLY_RESET is set.
 */
export function startRetentionMaintenance(
  options: RetentionMaintenanceOptions,
  deps: RetentionMaintenanceDeps,
): NodeJS.Timeout | null {
  if (getWeeklyReset() == null) {
    return null;
  }

  ensureLogsExpiryIndex().catch((error: unknown) => {
    logger.error('[retentionMaintenance] Could not create the logs expiry index:', error);
  });

  let running = false;
  const sweep = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      /* The storage volume is shared, so one replica sweeps it. */
      if (!(await deps.isLeader())) {
        return;
      }
      const cutoff = new Date(deps.now() - STALE_UPLOAD_MS);
      const temp = await sweepStaleUploads(options.uploadsPath, cutoff);
      const orphans = await sweepOrphanUploads([options.uploadsPath, options.imagesPath], deps);
      if (temp > 0 || orphans.deleted > 0 || orphans.retained > 0 || orphans.failed > 0) {
        logger.info(
          `[retentionMaintenance] Temp uploads removed: ${temp}; orphaned uploads removed: ${orphans.deleted}, kept for a vector retry: ${orphans.retained}, failed: ${orphans.failed}`,
        );
      }
    } catch (error) {
      logger.error('[retentionMaintenance] Upload sweep failed:', safeError(error));
    } finally {
      running = false;
    }
  };

  void sweep();
  const timer = setInterval(sweep, MAINTENANCE_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
