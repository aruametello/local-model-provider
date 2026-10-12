import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeRequestLog, pruneRequestLogs } from '../src/requestLog';

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lmp-requestlog-'));
  try {
    // Directory is created on demand (nested), content is valid JSON with the body embedded verbatim.
    const nested = path.join(dir, 'a', 'b');
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'héllo 🙂' }] });
    const first = await writeRequestLog(nested, 1_000_000, 'http://x/v1/chat/completions', body, new Date('2026-01-01T00:00:00Z'));
    const parsed = JSON.parse(await fs.readFile(first.file, 'utf8'));
    assert.equal(parsed.endpoint, 'http://x/v1/chat/completions');
    assert.deepEqual(parsed.request, JSON.parse(body));
    assert.equal(parsed.timestamp, '2026-01-01T00:00:00.000Z');

    // Pruning: 5 files of ~1000 bytes with increasing mtimes; limit 3500 keeps the 3 newest.
    const logs = path.join(dir, 'logs');
    await fs.mkdir(logs);
    const pad = 'x'.repeat(1000);
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      const name = `request-test-${i}.json`;
      await fs.writeFile(path.join(logs, name), pad);
      const t = new Date(2026, 0, 1, 0, 0, i);
      await fs.utimes(path.join(logs, name), t, t);
      names.push(name);
    }
    // Foreign files are never counted or deleted.
    await fs.writeFile(path.join(logs, 'notes.txt'), 'x'.repeat(50_000));

    const deleted = await pruneRequestLogs(logs, 3500);
    assert.deepEqual(deleted.sort(), [names[0], names[1]].sort());
    const left = (await fs.readdir(logs)).sort();
    assert.deepEqual(left, [names[2], names[3], names[4], 'notes.txt'].sort());

    // Writing a new file prunes oldest-first and keeps the folder under the limit (incl. the new file).
    const res = await writeRequestLog(logs, 3000, 'u', JSON.stringify({ a: pad }), new Date());
    const requestFiles = (await fs.readdir(logs)).filter((n) => n.startsWith('request-'));
    let total = 0;
    for (const n of requestFiles) {
      total += (await fs.stat(path.join(logs, n))).size;
    }
    assert.ok(total <= 3000, `total ${total} should be <= 3000`);
    assert.ok(requestFiles.includes(path.basename(res.file)), 'newest file kept');
    assert.ok(!requestFiles.includes(names[2]), 'oldest deleted first');

    // A single request larger than the limit is still kept (everything older is removed).
    const big = await writeRequestLog(logs, 10, 'u', JSON.stringify({ a: pad }), new Date());
    const afterBig = (await fs.readdir(logs)).filter((n) => n.startsWith('request-'));
    assert.deepEqual(afterBig, [path.basename(big.file)]);

    // Concurrent writes do not throw and file names are unique.
    const same = new Date('2026-02-02T00:00:00Z');
    const results = await Promise.all(Array.from({ length: 10 }, () => writeRequestLog(logs, 10_000_000, 'u', '{}', same)));
    assert.equal(new Set(results.map((r) => r.file)).size, 10);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  console.log('All request-log tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
