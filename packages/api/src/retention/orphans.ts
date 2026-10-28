import path from 'path';
import { promises as fs } from 'fs';
import { getWeeklyReset, nextWeeklyReset } from '@librechat/data-schemas';
import type { Dirent } from 'fs';

/** Older than any upload still waiting for its files row. */
export const ORPHAN_UPLOAD_MS: number = 60 * 60 * 1000;

/** Owner folders are user ObjectIds; anything else (temp, assets) is not an upload folder. */
const OWNER_FOLDER = /^[0-9a-f]{24}$/;
/** Stored uploads and images are named `<file_id>__<original name>`. */
const STORED_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})__/;
const LOOKUP_BATCH = 200;

export interface OrphanUploadDeps {
  /** The ids among `fileIds` that still have a files row. */
  findStoredFileIds: (fileIds: string[]) => Promise<Set<string>>;
  /** The ids among `fileIds` that some agent still references. */
  findAgentFileIds: (fileIds: string[]) => Promise<Set<string>>;
  /** Removes any vectors stored for the file; false when the vector store could not be reached. */
  deleteVectors: (userId: string, fileId: string) => Promise<boolean>;
  now: () => number;
}

export interface OrphanUploadResult {
  deleted: number;
  retained: number;
  failed: number;
}

interface Candidate {
  filePath: string;
  userId: string;
  fileId: string;
  mtimeMs: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

async function readEntries(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

async function modifiedAt(filePath: string): Promise<number | null> {
  try {
    return (await fs.lstat(filePath)).mtimeMs;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

/** Only `<root>/<owner>/<file_id>__<name>` regular files; links and nested folders are skipped. */
async function findCandidates(root: string, cutoff: number): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const owner of await readEntries(root)) {
    if (!owner.isDirectory() || !OWNER_FOLDER.test(owner.name)) {
      continue;
    }
    const ownerDir = path.join(root, owner.name);
    for (const entry of await readEntries(ownerDir)) {
      const fileId = STORED_NAME.exec(entry.name)?.[1];
      if (!entry.isFile() || fileId == null) {
        continue;
      }
      const filePath = path.join(ownerDir, entry.name);
      const mtimeMs = await modifiedAt(filePath);
      if (mtimeMs != null && mtimeMs < cutoff) {
        candidates.push({ filePath, userId: owner.name, fileId, mtimeMs });
      }
    }
  }
  return candidates;
}

/** Ids that must stay: any files row, or any agent reference. */
async function findKeptIds(candidates: Candidate[], deps: OrphanUploadDeps): Promise<Set<string>> {
  const kept = new Set<string>();
  const ids = [...new Set(candidates.map((candidate) => candidate.fileId))];
  for (let offset = 0; offset < ids.length; offset += LOOKUP_BATCH) {
    const batch = ids.slice(offset, offset + LOOKUP_BATCH);
    const [stored, referenced] = await Promise.all([
      deps.findStoredFileIds(batch),
      deps.findAgentFileIds(batch),
    ]);
    stored.forEach((id) => kept.add(id));
    referenced.forEach((id) => kept.add(id));
  }
  return kept;
}

/** A blob whose vectors could not be removed waits for a retry until its own week has ended. */
function weekEnded(mtimeMs: number, now: number): boolean {
  const reset = getWeeklyReset();
  return reset == null || nextWeeklyReset(reset, new Date(mtimeMs)).getTime() <= now;
}

/**
 * Deletes stored uploads and images older than an hour that no files row or agent references,
 * together with their vectors. An upload that fails after storing its blob leaves one behind,
 * and without a files row the retention sweep never finds it.
 */
export async function sweepOrphanUploads(
  roots: string[],
  deps: OrphanUploadDeps,
): Promise<OrphanUploadResult> {
  const now = deps.now();
  const result: OrphanUploadResult = { deleted: 0, retained: 0, failed: 0 };
  const candidates: Candidate[] = [];
  for (const root of new Set(roots)) {
    candidates.push(...(await findCandidates(root, now - ORPHAN_UPLOAD_MS)));
  }
  if (candidates.length === 0) {
    return result;
  }

  const kept = await findKeptIds(candidates, deps);
  for (const candidate of candidates) {
    if (kept.has(candidate.fileId)) {
      continue;
    }
    try {
      const vectorsGone = await deps.deleteVectors(candidate.userId, candidate.fileId);
      if (!vectorsGone && !weekEnded(candidate.mtimeMs, now)) {
        result.retained += 1;
        continue;
      }
      await fs.unlink(candidate.filePath);
      result.deleted += 1;
    } catch (error) {
      if (isMissing(error)) {
        continue;
      }
      result.failed += 1;
    }
  }
  return result;
}
