import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Request log: one file per chat-completion request holding the full context
 * sent upstream, so earlier exchanges can be inspected when debugging.
 *
 * Dependency-free (no vscode import) so `tsconfig.test.json` can compile it
 * standalone.
 */

const FILE_PREFIX = 'request-';
const FILE_SUFFIX = '.json';

let sequence = 0;
// Writes and prunes are serialized so concurrent requests cannot race the
// size accounting (two prunes deleting the same files, or both skipping).
let queue: Promise<unknown> = Promise.resolve();

export interface RequestLogResult {
  file: string;
  deleted: string[];
}

/**
 * Write one request to `directory` and then delete the oldest log files until
 * the folder's request logs total at most `maxBytes`. Only files this module
 * created (`request-*.json`) are counted or deleted; anything else the user
 * keeps in the folder is left alone. The file just written is never deleted,
 * even if it alone exceeds `maxBytes` (a single oversized request is still
 * worth keeping).
 *
 * `requestJson` is the already-serialized request body, embedded verbatim.
 */
export function writeRequestLog(
  directory: string,
  maxBytes: number,
  endpoint: string,
  requestJson: string,
  now: Date = new Date()
): Promise<RequestLogResult> {
  const run = queue.then(() => doWrite(directory, maxBytes, endpoint, requestJson, now));
  // Keep the chain alive after a failure.
  queue = run.catch(() => undefined);
  return run;
}

async function doWrite(
  directory: string,
  maxBytes: number,
  endpoint: string,
  requestJson: string,
  now: Date
): Promise<RequestLogResult> {
  await fs.mkdir(directory, { recursive: true });

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const name = `${FILE_PREFIX}${stamp}-${String(sequence++ % 1000).padStart(3, '0')}${FILE_SUFFIX}`;
  const file = path.join(directory, name);
  const content = `{"timestamp":${JSON.stringify(now.toISOString())},"endpoint":${JSON.stringify(endpoint)},"request":${requestJson}}\n`;
  await fs.writeFile(file, content, 'utf8');

  const deleted = await pruneRequestLogs(directory, maxBytes, name);
  return { file, deleted };
}

/**
 * Delete the oldest request logs (by modification time, file name as
 * tie-break) until their total size is <= `maxBytes`. `keepName` is never deleted.
 */
export async function pruneRequestLogs(directory: string, maxBytes: number, keepName?: string): Promise<string[]> {
  const entries = await fs.readdir(directory);
  const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
  for (const name of entries) {
    if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) {
      continue;
    }
    try {
      const stat = await fs.stat(path.join(directory, name));
      if (stat.isFile()) {
        files.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // File vanished between readdir and stat; ignore.
    }
  }

  let total = files.reduce((sum, f) => sum + f.size, 0);
  const deleted: string[] = [];
  if (total <= maxBytes) {
    return deleted;
  }

  files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const f of files) {
    if (total <= maxBytes) {
      break;
    }
    if (f.name === keepName) {
      continue;
    }
    try {
      await fs.unlink(path.join(directory, f.name));
      total -= f.size;
      deleted.push(f.name);
    } catch {
      // Could not delete (locked/removed); skip it and keep going.
    }
  }
  return deleted;
}
