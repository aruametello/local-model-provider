import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendConnectionLog,
  connectionLogFileName,
  openConnectionCount,
  pruneConnectionLogs,
  startConnectionTrace,
} from '../src/connectionLog';

async function main(): Promise<void> {
  // --- Trace lines: sequential requests never report an overlap. ---
  let t = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => t;
  const lines: string[] = [];
  const a = startConnectionTrace('http://x/v1/chat/completions', (l) => lines.push(l), clock);
  assert.deepEqual(a.overlappedWith, []);
  assert.equal(openConnectionCount(), 1);
  t += 100; a.headers(200);
  t += 50; a.data(10);
  t += 50; a.data(20);
  t += 10; a.end('eof');
  a.end('eof'); // idempotent
  assert.equal(openConnectionCount(), 0);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^2026-01-01T00:00:00\.000Z #\d+ start +open=1 POST http:\/\/x\/v1\/chat\/completions$/);
  assert.match(lines[1], / headers +open=1 status=200 \+100ms$/);
  assert.match(lines[2], / first-data +open=1 \+150ms$/);
  assert.match(lines[3], / end +open=0 reason=eof duration=210ms last-data=\+200ms chunks=2 bytes=30$/);

  const b = startConnectionTrace('u', (l) => lines.push(l), clock);
  assert.deepEqual(b.overlappedWith, []);
  b.end('eof');

  // --- Overlap: a request starting while another is open is flagged. ---
  const overlapLines: string[] = [];
  const c = startConnectionTrace('u', (l) => overlapLines.push(l), clock);
  const d = startConnectionTrace('u', (l) => overlapLines.push(l), clock);
  assert.deepEqual(d.overlappedWith, [c.id]);
  assert.equal(openConnectionCount(), 2);
  assert.ok(overlapLines.some((l) => l.includes(`#${d.id} OVERLAP`) && l.includes(`#${c.id} still open`) && l.includes('open=2')));
  d.end('eof');
  c.end('cancelled');
  assert.equal(openConnectionCount(), 0);
  // An end with no data says so.
  assert.match(overlapLines[overlapLines.length - 1], /reason=cancelled .*last-data=none chunks=0 bytes=0$/);

  // --- File output: daily file, appended, created on demand. ---
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lmp-connlog-'));
  try {
    const nested = path.join(dir, 'logs');
    const day = new Date('2026-03-04T10:00:00Z');
    assert.equal(connectionLogFileName(day), 'connections-2026-03-04.log');
    await Promise.all([
      appendConnectionLog(nested, 'line 1', day),
      appendConnectionLog(nested, 'line 2 ✓', day),
    ]);
    assert.equal(await fs.readFile(path.join(nested, 'connections-2026-03-04.log'), 'utf8'), 'line 1\nline 2 ✓\n');

    // Pruning keeps the newest N daily files and never touches other files.
    for (let i = 1; i <= 5; i++) {
      await fs.writeFile(path.join(nested, `connections-2026-02-0${i}.log`), 'x');
    }
    await fs.writeFile(path.join(nested, 'request-keep.json'), '{}');
    const deleted = await pruneConnectionLogs(nested, 3);
    assert.deepEqual(deleted.sort(), ['connections-2026-02-01.log', 'connections-2026-02-02.log', 'connections-2026-02-03.log']);
    assert.deepEqual((await fs.readdir(nested)).sort(), [
      'connections-2026-02-04.log', 'connections-2026-02-05.log', 'connections-2026-03-04.log', 'request-keep.json',
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  console.log('All connection-log tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
