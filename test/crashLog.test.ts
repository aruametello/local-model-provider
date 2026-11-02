/**
 * Crash reports (`src/crashLog.ts`) — the "how did I get here" file written on
 * every failed chat request. Two things matter here and both are safety
 * properties rather than features: secrets must never reach disk, and the
 * logging path must never break the user-facing error path.
 *
 * The `./vscodeRuntime` import MUST stay first: it installs the `Module._load`
 * hook that serves the `vscode` stub to `../src` modules (crashLog.ts imports
 * `vscode` for `workspace.fs` and `Uri`).
 */
import './vscodeRuntime';

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, run, test } from './harness';
import { createContext, makeTempDir } from './vscodeRuntime';
import { buildCrashReport, writeCrashReport } from '../src/crashLog';
import { GatewayError } from '../src/client';

/**
 * `buildCrashReport` never reads the context (only `writeCrashReport` does), so
 * the report-building cases need no disk at all.
 */
const ctx: any = {};

/** Standard-alphabet base64 body used to imitate an inline image payload. */
const IMAGE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const API_KEY = 'sk-proj-AbCdEf1234567890';
const BEARER = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

const CRASH_FILE = /^crash-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.log$/;

/** Runs `fn` inside a throwaway directory and always removes it again. */
async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = makeTempDir('lmp-crash-');
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A `LanguageModelChatInformation`-shaped object (the stub never validates). */
function chatModel(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'qwen3-27b',
    name: 'Qwen3 27B',
    family: 'qwen',
    version: '1.0.0',
    maxInputTokens: 131072,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: false },
    ...overrides,
  };
}

/** Captures `console.error` output so a tolerated failure stays quiet on screen. */
async function withCapturedConsoleError<T>(fn: () => Promise<T>): Promise<{ result: T; messages: string[] }> {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(' '));
  };
  try {
    return { result: await fn(), messages };
  } finally {
    console.error = original;
  }
}

/**
 * Replaces the global `Date` so `new Date()` (no args) is frozen. Needed to
 * exercise the same-millisecond collision in `writeCrashReport` deterministically.
 */
async function withFrozenClock<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const OriginalDate = Date;
  class FrozenDate extends OriginalDate {
    constructor() {
      super(iso);
    }
  }
  (globalThis as unknown as { Date: unknown }).Date = FrozenDate;
  try {
    return await fn();
  } finally {
    (globalThis as unknown as { Date: unknown }).Date = OriginalDate;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// buildCrashReport: structure and diagnostics
// ---------------------------------------------------------------------------

describe('buildCrashReport structure', () => {
  test('wraps the report in a banner and an end marker', async () => {
    const report = buildCrashReport(createContext(), undefined, new Error('boom'));
    const lines = report.split('\n');
    assert.equal(lines[0], '==============================================================');
    assert.ok(report.includes('Local Model Provider'), 'identifies the extension');
    assert.equal(lines[lines.length - 1], '--- end of report ---');

    const generated = / Generated: (.+)/.exec(report);
    assert.ok(generated, 'carries a Generated line');
    const when = Date.parse(generated![1]);
    assert.ok(!Number.isNaN(when), 'Generated is a parseable timestamp');
    assert.ok(Math.abs(when - Date.now()) < 60_000, 'Generated is the current time');
  });

  test('reports a plain Error by name, message and stack', () => {
    const error = new Error('upstream exploded');
    error.name = 'FetchError';
    const report = buildCrashReport(createContext(), undefined, error);
    assert.ok(report.includes('--- Error ---'));
    assert.ok(report.includes('  Type: FetchError'));
    assert.ok(report.includes('  Message: upstream exploded'));
    assert.ok(report.includes('  Stack:'));
    // Stack lines are indented under the Stack: header, until the next section.
    const afterHeader = report.split('  Stack:')[1].split('\n').slice(1);
    const indented: string[] = [];
    for (const line of afterHeader) {
      if (!/^\s{4,}\S/.test(line)) {
        break;
      }
      indented.push(line);
    }
    assert.ok(indented.length > 1, 'expected indented stack frames');
    assert.ok(indented.every((l) => l.startsWith('    ')));
  });

  test('reports non-Error throwables by typeof instead of crashing', () => {
    assert.ok(buildCrashReport(createContext(), undefined, 'boom').includes('  Type: string'));
    assert.ok(buildCrashReport(createContext(), undefined, 'boom').includes('  Message: boom'));
    assert.ok(buildCrashReport(createContext(), undefined, undefined).includes('  Type: undefined'));
    assert.ok(buildCrashReport(createContext(), undefined, undefined).includes('  Message: undefined'));
    const objectReport = buildCrashReport(createContext(), undefined, { code: 42 });
    assert.ok(objectReport.includes('  Type: object'));
    assert.ok(objectReport.includes('  Message: [object Object]'));
    assert.ok(!objectReport.includes('  Stack:'), 'no stack section without a stack');
  });

  test('reports GatewayError status code, retryability and original error', () => {
    const error = new GatewayError('HTTP 502 from server', 502, true, new Error('ECONNRESET'));
    const report = buildCrashReport(createContext(), undefined, error);
    assert.ok(report.includes('  Type: GatewayError'));
    assert.ok(report.includes('  Status code: 502'));
    assert.ok(report.includes('  Retryable: true'));
    assert.ok(report.includes('  Original error: ECONNRESET'));
    assert.ok(report.includes('  Message: HTTP 502 from server'));
  });

  test('shows n/a for a GatewayError without status or original error', () => {
    const report = buildCrashReport(createContext(), undefined, new GatewayError('stream stalled'));
    assert.ok(report.includes('  Status code: n/a'));
    assert.ok(report.includes('  Retryable: false'));
    assert.ok(!report.includes('Original error'));
  });

  test('lists the model diagnostics the next debugging session needs', () => {
    const report = buildCrashReport(createContext(), chatModel(), new Error('boom'));
    assert.ok(report.includes('Model'));
    assert.ok(report.includes('  id: qwen3-27b'));
    assert.ok(report.includes('  family: qwen'));
    assert.ok(report.includes('  version: 1.0.0'));
    assert.ok(report.includes('  maxInputTokens: 131072'));
    assert.ok(report.includes('  maxOutputTokens: 65536'));
    assert.ok(report.includes('  capabilities: {"toolCalling":true,"imageInput":false}'));
  });

  test('falls back to n/a per field and (unknown) for a missing model', () => {
    const partial = buildCrashReport(createContext(), chatModel({ family: undefined, capabilities: undefined }), new Error('boom'));
    assert.ok(partial.includes('  id: qwen3-27b'));
    assert.ok(partial.includes('  family: n/a'));
    assert.ok(partial.includes('  capabilities: n/a'));
    const none = buildCrashReport(createContext(), undefined, new Error('boom'));
    assert.ok(none.includes('  (unknown)'));
  });

  test('omits the snapshot section entirely when nothing was captured', () => {
    const report = buildCrashReport(createContext(), chatModel(), new Error('boom'));
    assert.ok(!report.includes('Request snapshot'));
  });

  test('prints every snapshot field, including zero values', () => {
    const report = buildCrashReport(createContext(), chatModel(), new Error('boom'), {
      messageCount: 0,
      estimatedInputTokens: 12_345,
      toolsOverhead: 0,
      modelMaxContext: 131_072,
      chosenMaxOutputTokens: 8192,
    });
    assert.ok(report.includes('Request snapshot'));
    assert.ok(report.includes('  messageCount: 0'), 'zero is not treated as absent');
    assert.ok(report.includes('  estimatedInputTokens: 12345'));
    assert.ok(report.includes('  toolsOverhead: 0'));
    assert.ok(report.includes('  modelMaxContext: 131072'));
    assert.ok(report.includes('  chosenMaxOutputTokens: 8192'));
  });

  test('omits snapshot fields that were never set', () => {
    const report = buildCrashReport(createContext(), chatModel(), new Error('boom'), {
      messageCount: 3,
      estimatedInputTokens: undefined,
    });
    assert.ok(report.includes('  messageCount: 3'));
    assert.ok(!report.includes('estimatedInputTokens'));
    assert.ok(!report.includes('requestOptions'));
    assert.ok(!report.includes('config:'));
  });

  test('pretty-prints requestOptions and config as JSON', () => {
    const report = buildCrashReport(createContext(), chatModel(), new Error('boom'), {
      requestOptions: { model: 'qwen3-27b', max_tokens: 8192 },
      config: { serverUrl: 'http://localhost:8080/v1' },
    });
    assert.ok(report.includes('"model": "qwen3-27b"'), '2-space indented JSON');
    assert.ok(report.includes('"max_tokens": 8192'));
    assert.ok(report.includes('"serverUrl": "http://localhost:8080/v1"'));
  });

  test('KNOWN QUIRK: buildCrashReport never touches the extension context it is given', () => {
    // crashLog.ts:47 declares `context` but only writeCrashReport uses it, so a
    // context without any storage URI is still enough to build a report
    // (harmless today, but the parameter is dead weight).
    const context: any = { subscriptions: [] };
    assert.equal(context.globalStorageUri, undefined);
    const report = buildCrashReport(context, chatModel(), new Error('boom'));
    assert.ok(report.includes('--- end of report ---'));
  });

  test('KNOWN QUIRK: the chosen output budget vanishes under the provider field name', () => {
    // provider.ts:2000 hands handleChatError `chosenMaxTokens`, while
    // buildCrashReport only reads `chosenMaxOutputTokens`, so the real crash
    // reports never contain the max_tokens that was actually sent.
    const report = buildCrashReport(createContext(), chatModel(), new Error('boom'), {
      messageCount: 4,
      chosenMaxTokens: 8192,
    } as unknown as Parameters<typeof buildCrashReport>[3]);
    assert.ok(!report.includes('chosenMax'), 'the value is silently dropped');
    const named = buildCrashReport(createContext(), chatModel(), new Error('boom'), {
      chosenMaxOutputTokens: 8192,
    });
    assert.ok(named.includes('  chosenMaxOutputTokens: 8192'), 'the expected name does print');
  });
});

// ---------------------------------------------------------------------------
// buildCrashReport: redaction
// ---------------------------------------------------------------------------

describe('buildCrashReport redaction', () => {
  test('redacts sk- API keys in the config and request options', () => {
    const report = buildCrashReport(createContext(), chatModel(), new Error('boom'), {
      requestOptions: { headers: { authorization: API_KEY } },
      config: { apiKey: API_KEY },
    });
    assert.ok(!report.includes(API_KEY), 'the key never reaches the report');
    assert.ok(report.includes('[REDACTED]'));
  });

  test('redacts sk- keys embedded in longer strings, everywhere they appear', () => {
    const report = buildCrashReport(createContext(), chatModel(), new Error('boom'), {
      requestOptions: {
        url: `http://host/v1?key=${API_KEY}`,
        notes: [`first ${API_KEY} second`, { nested: `tail ${API_KEY}` }],
      },
    });
    assert.ok(!report.includes(API_KEY));
    assert.ok(report.includes('http://host/v1?key=[REDACTED]'));
    assert.equal(report.match(/\[REDACTED\]/g)?.length, 3, 'each occurrence is redacted');
  });

  test('redacts Bearer tokens but keeps the scheme prefix', () => {
    const report = buildCrashReport(createContext(), chatModel(), new Error('boom'), {
      requestOptions: { headers: { Authorization: `Bearer ${BEARER}`, proxy: 'bearer lowercase.token-1' } },
    });
    assert.ok(!report.includes(BEARER));
    assert.ok(report.includes('Bearer [REDACTED]'));
    assert.ok(report.includes('bearer [REDACTED]'), 'the match is case-insensitive');
    assert.ok(report.includes('"Authorization"'), 'the field name survives for diagnosis');
  });

  test('redacts base64 image payloads but keeps the data URL prefix', () => {
    const report = buildCrashReport(createContext(), chatModel(), new Error('boom'), {
      requestOptions: {
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE_B64}` } }] }],
      },
    });
    assert.ok(!report.includes(IMAGE_B64), 'no base64 blob on disk');
    assert.ok(report.includes('data:image/png;base64,[REDACTED]'));
    assert.ok(report.includes('"image_url"'), 'the multimodal shape is still visible');
  });

  test('KNOWN QUIRK: secrets that do not match the three patterns are written verbatim', () => {
    // Redaction is content-based, not key-based: a non-`sk-` key, a password or
    // a URL-safe base64 blob pass straight through. provider.ts hides apiKey
    // itself (configToLog), which is the only thing keeping this safe today.
    const report = buildCrashReport(createContext(), chatModel(), new Error('boom'), {
      config: { apiKey: 'hunter2', password: 'correct horse battery staple' },
    });
    assert.ok(report.includes('"apiKey": "hunter2"'));
    assert.ok(report.includes('correct horse battery staple'));
  });

  test('KNOWN QUIRK: a short sk- key (fewer than 8 chars after the prefix) leaks', () => {
    const report = buildCrashReport(createContext(), chatModel(), new Error('boom'), {
      config: { apiKey: 'sk-abc123' },
    });
    assert.ok(report.includes('sk-abc123'), 'the {8,} quantifier lets short keys through');
  });

  test('KNOWN QUIRK: raw base64 without a data: URL prefix is not redacted', () => {
    const report = buildCrashReport(createContext(), chatModel(), new Error('boom'), {
      requestOptions: { image: IMAGE_B64, images: [IMAGE_B64] },
    });
    assert.ok(report.includes(IMAGE_B64), 'only the data:image/...;base64, form is masked');
  });

  test('KNOWN QUIRK: the error message and stack are NOT redacted', () => {
    // Only requestOptions/config go through redact(). A server error that
    // echoes the Authorization header, or a message embedding a data URL, is
    // copied into the report verbatim.
    const error = new Error(`401 Unauthorized for key ${API_KEY} with payload data:image/png;base64,${IMAGE_B64}`);
    const report = buildCrashReport(createContext(), chatModel(), error);
    assert.ok(report.includes(API_KEY), 'the secret leaks through the Message line');
    assert.ok(report.includes(IMAGE_B64));
  });

  test('preserves every non-secret diagnostic while redacting', () => {
    const report = buildCrashReport(createContext(), chatModel(), new Error('boom'), {
      messageCount: 7,
      estimatedInputTokens: 999,
      toolsOverhead: 512,
      modelMaxContext: 32_768,
      chosenMaxOutputTokens: 4096,
      requestOptions: {
        model: 'qwen3-27b',
        max_tokens: 4096,
        stream: true,
        ratio: 1.5,
        nothing: null,
        tools: [{ type: 'function', function: { name: 'read_file' } }],
        dropped: undefined,
      },
    });
    assert.ok(report.includes('  messageCount: 7'));
    assert.ok(report.includes('"model": "qwen3-27b"'));
    assert.ok(report.includes('"max_tokens": 4096'));
    assert.ok(report.includes('"stream": true'));
    assert.ok(report.includes('"ratio": 1.5'));
    assert.ok(report.includes('"nothing": null'));
    assert.ok(report.includes('"name": "read_file"'));
    assert.ok(!report.includes('dropped'), 'undefined values disappear in the JSON pass');
  });

  test('does not mutate the caller snapshot objects', () => {
    const requestOptions = {
      apiKey: API_KEY,
      messages: [{ content: `data:image/png;base64,${IMAGE_B64}` }],
    };
    const before = JSON.parse(JSON.stringify(requestOptions));
    buildCrashReport(createContext(), chatModel(), new Error('boom'), { requestOptions });
    assert.deepEqual(requestOptions, before, 'redact() must copy, not edit in place');
  });

  test('KNOWN QUIRK: a circular requestOptions crashes the report builder', () => {
    // redact() recurses without cycle detection, so buildCrashReport throws.
    // handleChatError calls it OUTSIDE any try/catch (provider.ts:1637), which
    // means such a snapshot turns error handling itself into the failure.
    const circular: Record<string, unknown> = { model: 'qwen3-27b' };
    circular.self = circular;
    assert.throws(
      () => buildCrashReport(createContext(), chatModel(), new Error('boom'), { requestOptions: circular }),
      (err: unknown) => err instanceof RangeError || err instanceof TypeError
    );
  });
});

// ---------------------------------------------------------------------------
// writeCrashReport
// ---------------------------------------------------------------------------

describe('writeCrashReport', () => {
  test('creates the storage folder, writes the file and returns its path', async () => {
    await withTempDir(async (dir) => {
      const storage = path.join(dir, 'globalStorage'); // deliberately not created yet
      const context = createContext(storage);
      const report = buildCrashReport(context, chatModel(), new Error('boom'));

      const file = await writeCrashReport(context, report);
      assert.ok(file, 'a usable path is returned');
      assert.ok(path.isAbsolute(file!), 'the path can be shown to the user');
      assert.equal(path.dirname(path.resolve(file!)), path.resolve(storage));
      assert.match(path.basename(file!), CRASH_FILE, 'crash-<timestamp>.log');
      assert.equal(fs.readFileSync(file!, 'utf8'), report, 'the file holds the report verbatim');
    });
  });

  test('keeps a history: two failures produce two files with sortable names', async () => {
    await withTempDir(async (dir) => {
      const context = createContext(path.join(dir, 'global'));
      const first = await writeCrashReport(context, 'report one');
      await sleep(5); // the file name has millisecond resolution
      const second = await writeCrashReport(context, 'report two');

      assert.ok(first && second && first !== second);
      const names = fs.readdirSync(path.join(dir, 'global')).sort();
      assert.equal(names.length, 2);
      assert.ok(names.every((n) => CRASH_FILE.test(n)), `unexpected file names: ${names.join(', ')}`);
      assert.ok(names.indexOf(path.basename(first!)) < names.indexOf(path.basename(second!)), 'names sort chronologically');
      assert.equal(fs.readFileSync(second!, 'utf8'), 'report two');
    });
  });

  test('KNOWN QUIRK: two failures inside the same millisecond overwrite each other', async () => {
    // The file name is the only uniqueness source, and it has ms resolution, so
    // a burst of failures loses all but the last report.
    await withTempDir(async (dir) => {
      const storage = path.join(dir, 'global');
      const context = createContext(storage);
      const [one, two] = await withFrozenClock('2026-01-01T12:00:00.000Z', async () => [
        await writeCrashReport(context, 'first report'),
        await writeCrashReport(context, 'second report'),
      ] as const);

      assert.equal(one, two, 'same timestamp, same file name');
      assert.equal(fs.readdirSync(storage).length, 1);
      assert.equal(fs.readFileSync(two!, 'utf8'), 'second report');
    });
  });

  test('tolerates a storage path that cannot be created', async () => {
    await withTempDir(async (dir) => {
      const blocker = path.join(dir, 'blocker');
      fs.writeFileSync(blocker, 'a file where a directory must be');
      const context = createContext(path.join(blocker, 'storage'));

      const { result, messages } = await withCapturedConsoleError(() => writeCrashReport(context, 'report'));
      assert.equal(result, undefined, 'no path is claimed for a file that was never written');
      assert.equal(messages.length, 1, 'the failure is reported on the console');
      assert.ok(messages[0].includes('Failed to write crash report'));
    });
  });

  test('tolerates a context with no globalStorageUri at all', async () => {
    const context: any = { subscriptions: [] };
    assert.equal(context.globalStorageUri, undefined);
    const { result, messages } = await withCapturedConsoleError(() => writeCrashReport(context, 'report'));
    assert.equal(result, undefined);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].includes('Failed to write crash report'));
  });

  test('tolerates a storage folder that exists but rejects the write', async () => {
    await withTempDir(async (dir) => {
      const storage = path.join(dir, 'global');
      fs.mkdirSync(storage);
      const context = createContext(storage);
      // Freeze the clock and pre-create a DIRECTORY with the exact file name
      // the writer is about to pick, so `writeFile` itself fails.
      const frozen = '2026-01-01T12:00:00.000Z';
      const name = `crash-${new Date(frozen).toISOString().replace(/[:.]/g, '-')}.log`;
      fs.mkdirSync(path.join(storage, name));
      const { result, messages } = await withFrozenClock(frozen, () =>
        withCapturedConsoleError(() => writeCrashReport(context, 'report'))
      );
      assert.equal(result, undefined);
      assert.equal(messages.length, 1);
    });
  });

  test('writes an empty report instead of failing', async () => {
    await withTempDir(async (dir) => {
      const context = createContext(path.join(dir, 'global'));
      const file = await writeCrashReport(context, '');
      assert.ok(file);
      assert.equal(fs.readFileSync(file!, 'utf8'), '');
    });
  });
});

void run();
