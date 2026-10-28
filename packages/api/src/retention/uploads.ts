import path from 'path';
import { promises as fs } from 'fs';
import type { Dirent } from 'fs';

/** No upload request runs this long, so a temp file this old has lost its request. */
export const STALE_UPLOAD_MS: number = 60 * 60 * 1000;

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

async function removeIfStale(filePath: string, cutoff: Date): Promise<boolean> {
  try {
    const { mtimeMs } = await fs.stat(filePath);
    if (mtimeMs >= cutoff.getTime()) {
      return false;
    }
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Deletes multer temp uploads (`<uploads>/temp/<user>/<file>`) last modified before `cutoff`.
 * Each upload route removes its own file when it finishes, so these are files whose request
 * died first, and no files row or sweep would ever remove them.
 */
export async function sweepStaleUploads(uploadsPath: string, cutoff: Date): Promise<number> {
  const tempDir = path.join(uploadsPath, 'temp');
  let deleted = 0;
  for (const owner of await readEntries(tempDir)) {
    if (!owner.isDirectory()) {
      continue;
    }
    const ownerDir = path.join(tempDir, owner.name);
    for (const entry of await readEntries(ownerDir)) {
      if (entry.isFile() && (await removeIfStale(path.join(ownerDir, entry.name), cutoff))) {
        deleted += 1;
      }
    }
  }
  return deleted;
}
