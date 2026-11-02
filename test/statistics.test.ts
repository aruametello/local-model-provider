/**
 * Session statistics (`src/statistics.ts`) — the numbers behind the status-bar
 * tooltip and the "Show Statistics" command: token/duration formatting, the
 * session and per-model aggregates, and the `onStatsUpdate` event that drives
 * the live status bar.
 *
 * The `./vscodeRuntime` import MUST stay first: it installs the `Module._load`
 * hook that serves the `vscode` stub to `../src` modules.
 */
import './vscodeRuntime';

import * as assert from 'node:assert/strict';

import { describe, run, test } from './harness';
import { readPrivate, resetStub } from './vscodeRuntime';
import { StatisticsManager } from '../src/statistics';

const formatTokens = StatisticsManager.formatTokens;
const formatDuration = StatisticsManager.formatDuration;

type Recorded = { modelId?: string; inputTokens?: number; outputTokens?: number; responseTimeMs?: number };

/** Records one request, overriding only what the case cares about. */
function record(manager: StatisticsManager, overrides: Recorded = {}): void {
  manager.recordRequest({
    modelId: overrides.modelId ?? 'model-a',
    inputTokens: overrides.inputTokens ?? 100,
    outputTokens: overrides.outputTokens ?? 50,
    responseTimeMs: overrides.responseTimeMs ?? 1000,
  });
}

function newManager(): StatisticsManager {
  resetStub();
  return new StatisticsManager();
}

/** Collects every payload delivered to `onStatsUpdate`. */
function listen(manager: StatisticsManager): { payloads: Array<Record<string, unknown>>; dispose: () => void } {
  const payloads: Array<Record<string, unknown>> = [];
  const subscription = manager.onStatsUpdate((stats) => {
    payloads.push(stats as unknown as Record<string, unknown>);
  });
  return { payloads, dispose: () => subscription.dispose() };
}

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe('StatisticsManager.formatTokens', () => {
  test('keeps zero and sub-threshold counts as plain integers', () => {
    assert.equal(formatTokens(0), '0');
    assert.equal(formatTokens(1), '1');
    assert.equal(formatTokens(999), '999');
  });

  test('switches to K exactly at 1000', () => {
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1000), '1.0K');
    assert.equal(formatTokens(1001), '1.0K');
    assert.equal(formatTokens(1500), '1.5K');
  });

  test('switches to M exactly at 1_000_000', () => {
    assert.equal(formatTokens(999_999), '1000.0K'); // see the quirk case below
    assert.equal(formatTokens(1_000_000), '1.0M');
    assert.equal(formatTokens(1_500_000), '1.5M');
    assert.equal(formatTokens(256_000_000), '256.0M');
  });

  test('always shows one decimal above the threshold', () => {
    assert.equal(formatTokens(1234), '1.2K');
    assert.equal(formatTokens(1_234_567), '1.2M');
    assert.equal(formatTokens(9_999), '10.0K');
  });

  test('KNOWN QUIRK: 999_999 renders as "1000.0K", never as a megabyte count', () => {
    // The M branch only wins at >= 1_000_000, so the K branch rounds up past
    // its own unit. Cosmetic, but a status bar reading "1000.0K" is real.
    assert.equal(formatTokens(999_999), '1000.0K');
  });

  test('KNOWN QUIRK: negatives, NaN and Infinity bypass the unit thresholds', () => {
    // The guards are `count >= 1000`, so anything negative falls through to
    // toString(); NaN/Infinity take the M branch and stringify to "Infinity".
    assert.equal(formatTokens(-1500), '-1500');
    assert.equal(formatTokens(-2_000_000), '-2000000');
    assert.equal(formatTokens(Number.NaN), 'NaN');
    assert.equal(formatTokens(Number.POSITIVE_INFINITY), 'InfinityM');
  });

  test('formats fractional counts like any other number', () => {
    assert.equal(formatTokens(0.5), '0.5');
    assert.equal(formatTokens(1500.4), '1.5K');
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('StatisticsManager.formatDuration', () => {
  test('keeps sub-second durations in milliseconds', () => {
    assert.equal(formatDuration(0), '0ms');
    assert.equal(formatDuration(1), '1ms');
    assert.equal(formatDuration(999), '999ms');
  });

  test('switches to seconds exactly at 1000', () => {
    assert.equal(formatDuration(1000), '1.0s');
    assert.equal(formatDuration(1500), '1.5s');
    assert.equal(formatDuration(1234), '1.2s');
  });

  test('switches to minutes exactly at 60000', () => {
    assert.equal(formatDuration(59_999), '60.0s'); // see the quirk case below
    assert.equal(formatDuration(60_000), '1.0m');
    assert.equal(formatDuration(90_000), '1.5m');
    assert.equal(formatDuration(123_456), '2.1m');
  });

  test('KNOWN QUIRK: 59_999 renders as "60.0s", never as a minute', () => {
    assert.equal(formatDuration(59_999), '60.0s');
  });

  test('KNOWN QUIRK: negative, NaN and fractional ms fall through to the ms branch', () => {
    assert.equal(formatDuration(-2000), '-2000ms');
    assert.equal(formatDuration(999.5), '999.5ms');
    assert.equal(formatDuration(Number.NaN), 'NaNms');
    assert.equal(formatDuration(Number.POSITIVE_INFINITY), 'Infinitym');
  });
});

// ---------------------------------------------------------------------------
// recordRequest + getSessionStats
// ---------------------------------------------------------------------------

describe('StatisticsManager.getSessionStats', () => {
  test('starts an empty session with zeroed totals', () => {
    const stats = newManager().getSessionStats();
    assert.equal(stats.totalRequests, 0);
    assert.equal(stats.totalInputTokens, 0);
    assert.equal(stats.totalOutputTokens, 0);
    assert.equal(stats.averageResponseTimeMs, 0);
    assert.equal(stats.lastResponseTimeMs, 0);
    assert.ok(stats.sessionStartTime instanceof Date);
  });

  test('sums tokens across every request', () => {
    const manager = newManager();
    record(manager, { inputTokens: 100, outputTokens: 10 });
    record(manager, { inputTokens: 250, outputTokens: 40 });
    record(manager, { inputTokens: 0, outputTokens: 0 });
    const stats = manager.getSessionStats();
    assert.equal(stats.totalRequests, 3);
    assert.equal(stats.totalInputTokens, 350);
    assert.equal(stats.totalOutputTokens, 50);
  });

  test('averages response times and rounds to whole milliseconds', () => {
    const manager = newManager();
    record(manager, { responseTimeMs: 100 });
    record(manager, { responseTimeMs: 150 });
    record(manager, { responseTimeMs: 200 });
    assert.equal(manager.getSessionStats().averageResponseTimeMs, 150);

    // Math.round(201 / 2) === 101 (half rounds up).
    const second = newManager();
    record(second, { responseTimeMs: 100 });
    record(second, { responseTimeMs: 101 });
    assert.equal(second.getSessionStats().averageResponseTimeMs, 101);
  });

  test('lastResponseTimeMs always mirrors the newest request', () => {
    const manager = newManager();
    record(manager, { responseTimeMs: 1000 });
    record(manager, { responseTimeMs: 250 });
    assert.equal(manager.getSessionStats().lastResponseTimeMs, 250);
    record(manager, { responseTimeMs: 0 });
    assert.equal(manager.getSessionStats().lastResponseTimeMs, 0);
  });

  test('stamps each recorded request with the current time', () => {
    const manager = newManager();
    const before = Date.now();
    record(manager);
    const after = Date.now();
    const requests = readPrivate<Array<{ timestamp: Date }>>(manager, 'requests');
    assert.equal(requests.length, 1);
    assert.ok(requests[0].timestamp instanceof Date);
    assert.ok(requests[0].timestamp.getTime() >= before);
    assert.ok(requests[0].timestamp.getTime() <= after);
  });

  test('returns a snapshot: mutating the summary cannot corrupt the manager', () => {
    const manager = newManager();
    record(manager, { inputTokens: 10 });
    const first = manager.getSessionStats();
    first.totalInputTokens = 999_999;
    first.totalRequests = 42;
    assert.equal(manager.getSessionStats().totalInputTokens, 10);
    assert.equal(manager.getSessionStats().totalRequests, 1);
  });

  test('KNOWN QUIRK: token counts are not sanitised at this boundary', () => {
    // provider.ts sanitises server usage upstream (AGENTS.md §5); the manager
    // itself happily accumulates NaN, which then shows as "NaN" in the UI.
    const manager = newManager();
    record(manager, { inputTokens: Number.NaN });
    record(manager, { inputTokens: 100 });
    const stats = manager.getSessionStats();
    assert.ok(Number.isNaN(stats.totalInputTokens));
    assert.equal(formatTokens(stats.totalInputTokens), 'NaN');
  });

  test('KNOWN QUIRK: the request log grows unbounded for the whole session', () => {
    // No cap/window is applied — a long session keeps every RequestStats.
    const manager = newManager();
    for (let i = 0; i < 500; i++) {
      record(manager, { responseTimeMs: i });
    }
    assert.equal(readPrivate<unknown[]>(manager, 'requests').length, 500);
    assert.equal(manager.getSessionStats().totalRequests, 500);
  });
});

// ---------------------------------------------------------------------------
// getModelStats
// ---------------------------------------------------------------------------

describe('StatisticsManager.getModelStats', () => {
  test('is empty until something is recorded', () => {
    const stats = newManager().getModelStats();
    assert.ok(stats instanceof Map);
    assert.equal(stats.size, 0);
  });

  test('groups requests by model in first-seen order', () => {
    const manager = newManager();
    record(manager, { modelId: 'alpha', inputTokens: 10, outputTokens: 1 });
    record(manager, { modelId: 'beta', inputTokens: 20, outputTokens: 2 });
    record(manager, { modelId: 'alpha', inputTokens: 5, outputTokens: 3 });
    assert.deepEqual([...statsKeys(manager)], ['alpha', 'beta']);
    assert.deepEqual(manager.getModelStats().get('alpha'), { requests: 2, inputTokens: 15, outputTokens: 4 });
    assert.deepEqual(manager.getModelStats().get('beta'), { requests: 1, inputTokens: 20, outputTokens: 2 });
  });

  test('KNOWN QUIRK: model ids are matched exactly, so tagged ids split apart', () => {
    // Ollama reports `llava:7b` while OpenAI-style servers report `llava`;
    // there is no normalisation, so one model can occupy two rows.
    const manager = newManager();
    record(manager, { modelId: 'llava' });
    record(manager, { modelId: 'llava:7b' });
    assert.deepEqual([...statsKeys(manager)], ['llava', 'llava:7b']);
    assert.equal(manager.getModelStats().get('llava')?.requests, 1);
    assert.equal(manager.getModelStats().get('llava:7b')?.requests, 1);
  });

  test('returns freshly built entries (mutating them cannot leak back)', () => {
    const manager = newManager();
    record(manager, { modelId: 'alpha', inputTokens: 10, outputTokens: 1 });
    manager.getModelStats().get('alpha')!.inputTokens = 12_345;
    assert.equal(manager.getModelStats().get('alpha')?.inputTokens, 10);
  });

  test('KNOWN QUIRK: there is no per-server breakdown at all', () => {
    // Multiple server URLs collapse into one session because requests only
    // carry `modelId` — switching servers silently merges their statistics.
    const manager = newManager();
    assert.equal(typeof (manager as unknown as Record<string, unknown>)['getModelStats'], 'function');
    assert.equal(typeof (manager as unknown as Record<string, unknown>)['getServerStats'], 'undefined');
  });
});

function statsKeys(manager: StatisticsManager): IterableIterator<string> {
  return manager.getModelStats().keys();
}

// ---------------------------------------------------------------------------
// resetStats
// ---------------------------------------------------------------------------

describe('StatisticsManager.resetStats', () => {
  test('clears every counter', () => {
    const manager = newManager();
    record(manager);
    record(manager, { modelId: 'beta' });
    manager.resetStats();
    const stats = manager.getSessionStats();
    assert.equal(stats.totalRequests, 0);
    assert.equal(stats.totalInputTokens, 0);
    assert.equal(stats.totalOutputTokens, 0);
    assert.equal(stats.averageResponseTimeMs, 0);
    assert.equal(stats.lastResponseTimeMs, 0);
    assert.equal(manager.getModelStats().size, 0);
    assert.equal(readPrivate<unknown[]>(manager, 'requests').length, 0);
  });

  test('starts a new session window', () => {
    const manager = newManager();
    const before = manager.getSessionStats().sessionStartTime;
    record(manager);
    manager.resetStats();
    const after = manager.getSessionStats().sessionStartTime;
    assert.notEqual(after, before, 'reset must hand out a fresh start time');
    assert.ok(after.getTime() >= before.getTime());
  });

  test('notifies listeners with the zeroed summary', () => {
    const manager = newManager();
    record(manager);
    const { payloads } = listen(manager);
    manager.resetStats();
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].totalRequests, 0);
    assert.equal(payloads[0].totalInputTokens, 0);
  });
});

// ---------------------------------------------------------------------------
// onStatsUpdate
// ---------------------------------------------------------------------------

describe('StatisticsManager.onStatsUpdate', () => {
  test('fires exactly once per recordRequest', () => {
    const manager = newManager();
    const { payloads } = listen(manager);
    record(manager);
    record(manager);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].totalRequests, 1);
    assert.equal(payloads[1].totalRequests, 2);
  });

  test('carries the full SessionStats shape and matches getSessionStats', () => {
    const manager = newManager();
    const { payloads } = listen(manager);
    record(manager, { responseTimeMs: 1234 });
    const live = manager.getSessionStats();
    assert.deepEqual(payloads[0], live as unknown as Record<string, unknown>);
    assert.deepEqual(Object.keys(payloads[0]).sort(), [
      'averageResponseTimeMs',
      'lastResponseTimeMs',
      'sessionStartTime',
      'totalInputTokens',
      'totalOutputTokens',
      'totalRequests',
    ]);
  });

  test('delivers to every registered listener', () => {
    const manager = newManager();
    const first = listen(manager);
    const second = listen(manager);
    record(manager);
    assert.equal(first.payloads.length, 1);
    assert.equal(second.payloads.length, 1);
  });

  test('disposing the subscription stops delivery but keeps recording', () => {
    const manager = newManager();
    const { payloads, dispose } = listen(manager);
    record(manager);
    dispose();
    record(manager);
    assert.equal(payloads.length, 1, 'no event after the subscription was disposed');
    assert.equal(manager.getSessionStats().totalRequests, 2, 'recording is unaffected');
  });

  test('dispose() detaches every listener and is safe to call twice', () => {
    const manager = newManager();
    const { payloads } = listen(manager);
    manager.dispose();
    manager.dispose();
    record(manager);
    assert.equal(payloads.length, 0);
    // The stub's EventEmitter fires into an empty listener list; the real
    // vscode Emitter may reject post-dispose fires, so keep any call site that
    // records after dispose guarded.
    assert.equal(manager.getSessionStats().totalRequests, 1);
  });

  test('a listener registered after earlier ones still sees the same payload object', () => {
    const manager = newManager();
    const first = listen(manager);
    record(manager);
    const late = listen(manager);
    record(manager);
    assert.equal(first.payloads.length, 2);
    assert.equal(late.payloads.length, 1);
    assert.equal(first.payloads[1], late.payloads[0]);
  });
});

void run();
