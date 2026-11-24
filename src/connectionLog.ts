import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Connection log: one line per lifecycle event of every chat-completion HTTP
 * request (start, response headers, first data, end), with the number of
 * requests open at that moment. Written next to the request logs, in
 * `connections-<YYYY-MM-DD>.log` (UTC day), to diagnose requests that overlap
 * on the wire (the server briefly seeing two sessions / one queued request).
 *
 * Dependency-free (no vscode import) so `tsconfig.test.json` can compile it
 * standalone.
 */

const FILE_PREFIX = 'connections-';
const FILE_SUFFIX = '.log';
/** Daily files kept; older `connections-*.log` files are deleted. */
export const CONNECTION_LOG_KEEP_FILES = 14;

// Appends are serialized so lines from concurrent requests never interleave
// mid-line and pruning never races an append.
let queue: Promise<unknown> = Promise.resolve();
let lastFileName: string | undefined;

export function connectionLogFileName(now: Date): string {
  return `${FILE_PREFIX}${now.toISOString().slice(0, 10)}${FILE_SUFFIX}`;
}

/**
 * Append one line to today's connection log in `directory`. When a new day's
 * file is started, only the newest `CONNECTION_LOG_KEEP_FILES` connection logs
 * are kept. Files that are not `connections-*.log` are never touched.
 */
export function appendConnectionLog(directory: string, line: string, now: Date = new Date()): Promise<void> {
  const run = queue.then(() => doAppend(directory, line, now));
  queue = run.catch(() => undefined);
  return run;
}

async function doAppend(directory: string, line: string, now: Date): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const name = connectionLogFileName(now);
  await fs.appendFile(path.join(directory, name), `${line}\n`, 'utf8');
  if (name !== lastFileName) {
    lastFileName = name;
    await pruneConnectionLogs(directory, CONNECTION_LOG_KEEP_FILES);
  }
}

/** Delete all but the `keep` newest `connections-*.log` files (by name = by day). */
export async function pruneConnectionLogs(directory: string, keep: number): Promise<string[]> {
  const names = (await fs.readdir(directory))
    .filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(FILE_SUFFIX))
    .sort()
    .reverse();
  const deleted: string[] = [];
  for (const name of names.slice(Math.max(0, keep))) {
    try {
      await fs.unlink(path.join(directory, name));
      deleted.push(name);
    } catch {
      // Locked or already removed; skip.
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// In-flight tracking
// ---------------------------------------------------------------------------

// Module-level on purpose: counts requests across every GatewayClient
// instance, since the server sees all of them.
const openIds = new Set<number>();
let nextId = 1;

export interface ConnectionTrace {
  readonly id: number;
  /** Ids of requests still open when this one started (empty = no overlap). */
  readonly overlappedWith: readonly number[];
  /** Response headers received. */
  headers(status: number): void;
  /** A chunk of the body arrived (only the first one is logged). */
  data(bytes: number): void;
  /** Request finished; idempotent. */
  end(reason: string): void;
}

/** Number of chat requests currently open (for tests and diagnostics). */
export function openConnectionCount(): number {
  return openIds.size;
}

/**
 * Start tracing one HTTP request. `write` receives each formatted line; it is
 * called synchronously, so the order of lines matches the order of events.
 */
export function startConnectionTrace(
  endpoint: string,
  write: (line: string) => void,
  clock: () => number = Date.now
): ConnectionTrace {
  const id = nextId++;
  const overlappedWith = [...openIds];
  openIds.add(id);
  const startedAt = clock();
  let firstDataAt: number | undefined;
  let lastDataAt: number | undefined;
  let chunks = 0;
  let bytes = 0;
  let ended = false;

  const emit = (event: string, details: string): void => {
    const stamp = new Date(clock()).toISOString();
    write(`${stamp} #${id} ${event.padEnd(10)} open=${openIds.size}${details ? ` ${details}` : ''}`);
  };

  emit('start', `POST ${endpoint}`);
  if (overlappedWith.length > 0) {
    emit('OVERLAP', `started while ${overlappedWith.map((n) => `#${n}`).join(', ')} still open`);
  }

  return {
    id,
    overlappedWith,
    headers(status: number): void {
      emit('headers', `status=${status} +${clock() - startedAt}ms`);
    },
    data(size: number): void {
      const now = clock();
      chunks++;
      bytes += size;
      lastDataAt = now;
      if (firstDataAt === undefined) {
        firstDataAt = now;
        emit('first-data', `+${now - startedAt}ms`);
      }
    },
    end(reason: string): void {
      if (ended) { return; }
      ended = true;
      openIds.delete(id);
      const now = clock();
      const lastData = lastDataAt === undefined ? 'none' : `+${lastDataAt - startedAt}ms`;
      emit('end', `reason=${reason} duration=${now - startedAt}ms last-data=${lastData} chunks=${chunks} bytes=${bytes}`);
    },
  };
}
