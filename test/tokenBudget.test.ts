/**
 * Context-window splitting, output-token budgeting, token estimation and the
 * truncation/orphan-pruning rules.
 *
 * These numbers decide what actually goes on the wire, so they are the highest
 * value things to pin down: a wrong split inflates the VS Code context meter,
 * and a wrong budget overflows the server (HTTP 400) or truncates generations.
 */

import './vscodeRuntime'; // must precede ../src imports (installs the vscode stub)

import assert from 'node:assert/strict';
import { describe, test, run } from './harness';
import { invoke } from './vscodeRuntime';
import { createProvider, fakeToken, progressSink } from './providerFixture';
import { FALLBACK_CONTEXT_WINDOW } from '../src/provider';

// A provider with no server access needed: these methods are pure given config.
const { provider } = createProvider();
const split = (window: number) => invoke<{ maxInputTokens: number; maxOutputTokens: number }>(provider, 'splitContextWindow', window);
const safeMax = (input: number, tools: number, maxContext: number) =>
  invoke<number | undefined>(provider, 'calculateSafeMaxOutputTokens', input, tools, maxContext);
const estimable = (message: Record<string, unknown>) => invoke<string>(provider, 'extractEstimableText', message);
const estTokens = (message: Record<string, unknown>) => invoke<number>(provider, 'estimateMessageTokens', message);

// ---------------------------------------------------------------------------
// splitContextWindow
// ---------------------------------------------------------------------------

describe('splitContextWindow', () => {
  test('input + output always sum back to the real window', () => {
    for (const window of [128, 512, 4096, 8192, 32768, 131072, 262144, 1_048_576]) {
      const split_ = split(window);
      assert.equal(
        split_.maxInputTokens + split_.maxOutputTokens,
        window,
        `${window} must not be double-counted (VS Code shows input+output as the total)`
      );
    }
  });

  test('caps the output half at half the window so input is never starved', () => {
    // Default maxOutputTokens is 64k; on a 32k model the output half wins at 16k.
    const s = split(32768);
    assert.equal(s.maxOutputTokens, 16384);
    assert.equal(s.maxInputTokens, 16384);
  });

  test('on a large-context model the configured cap wins instead', () => {
    const s = split(262144);
    assert.equal(s.maxOutputTokens, 65536);
    assert.equal(s.maxInputTokens, 262144 - 65536);
  });

  test('honours a smaller maxOutputTokens setting', () => {
    const { provider: p } = createProvider({ maxOutputTokens: 4096 });
    const s = invoke<{ maxInputTokens: number; maxOutputTokens: number }>(p, 'splitContextWindow', 32768);
    assert.equal(s.maxOutputTokens, 4096);
    assert.equal(s.maxInputTokens, 32768 - 4096);
  });

  test('clamps absurdly small windows to a usable minimum', () => {
    const s = split(1);
    assert.ok(s.maxInputTokens >= 64 && s.maxOutputTokens >= 64);
  });
});

// ---------------------------------------------------------------------------
// calculateSafeMaxOutputTokens
// ---------------------------------------------------------------------------

describe('calculateSafeMaxOutputTokens', () => {
  test('is bounded by the output budget cap, not the whole window', () => {
    // 32k window, tiny input: the half-window cap (16384) wins.
    assert.equal(safeMax(1000, 0, 32768), 16384);
  });

  test('shrinks as the (conservatively scaled) input grows', () => {
    // ceil(20000*1.2)=24000 -> 32768-24000-256 = 8512
    assert.equal(safeMax(20000, 0, 32768), 8512);
    const smaller = safeMax(24000, 0, 32768);
    const bigger = safeMax(26000, 0, 32768);
    assert.ok((smaller as number) > (bigger as number));
  });

  test('counts tool schemas against the budget', () => {
    assert.equal(safeMax(10000, 5000, 32768), safeMax(15000, 0, 32768));
  });

  test('OMITS max_tokens (undefined) when the input already fills the window', () => {
    // Forcing even 64 here can overflow and produce an HTTP 400, so the field
    // must be left out entirely (see AGENTS.md §7).
    assert.equal(safeMax(27500, 0, 32768), undefined);
    assert.equal(safeMax(999999, 0, 32768), undefined);
  });

  test('respects a lowered maxOutputTokens setting', () => {
    const { provider: p } = createProvider({ maxOutputTokens: 1024 });
    assert.equal(invoke<number>(p, 'calculateSafeMaxOutputTokens', 100, 0, 32768), 1024);
  });
});

// ---------------------------------------------------------------------------
// getModelContextWindow
// ---------------------------------------------------------------------------

describe('getModelContextWindow', () => {
  test('recovers the shared window from the advertised input+output split', () => {
    const got = invoke<number>(provider, 'getModelContextWindow', { maxInputTokens: 16384, maxOutputTokens: 16384 });
    assert.equal(got, 32768);
  });

  test('falls back to the built-in window when a model reports nothing', () => {
    assert.equal(invoke<number>(provider, 'getModelContextWindow', {}), FALLBACK_CONTEXT_WINDOW);
    assert.equal(invoke<number>(provider, 'getModelContextWindow', { maxInputTokens: 0, maxOutputTokens: 0 }), FALLBACK_CONTEXT_WINDOW);
  });

  test('never uses maxInputTokens alone', () => {
    const got = invoke<number>(provider, 'getModelContextWindow', { maxInputTokens: 1000, maxOutputTokens: 500 });
    assert.equal(got, 1500);
  });
});

// ---------------------------------------------------------------------------
// Token estimation (must never count base64)
// ---------------------------------------------------------------------------

describe('extractEstimableText / estimateMessageTokens', () => {
  test('uses string content as-is', () => {
    assert.equal(estimable({ role: 'user', content: 'hello' }), 'hello');
    assert.equal(estTokens({ role: 'user', content: 'a'.repeat(400) }), 100);
  });

  test('joins the text of multimodal content parts', () => {
    const text = estimable({
      role: 'user',
      content: [{ type: 'text', text: 'one ' }, { type: 'text', text: 'two' }],
    });
    assert.equal(text, 'one two');
  });

  test('replaces an image part with a fixed budget, regardless of payload size', () => {
    const tiny = estimable({
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    });
    const huge = estimable({
      content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(4_000_000)}` } }],
    });
    assert.equal(tiny.length, huge.length, 'base64 must not inflate the estimate');
    // 150 tokens * 4 chars per token
    assert.equal(tiny.length, 600);
  });

  test('mixed text + image keeps the text and budgets the image once', () => {
    const text = estimable({
      content: [
        { type: 'text', text: 'look:' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${'B'.repeat(100000)}` } },
      ],
    });
    assert.ok(text.startsWith('look:'));
    assert.equal(text.length, 5 + 600);
  });

  test('counts tool_calls on an assistant message', () => {
    const text = estimable({
      role: 'assistant',
      content: 'sure',
      tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }],
    });
    assert.ok(text.startsWith('sure'));
    assert.ok(text.includes('c1'));
  });

  test('empty content estimates to zero tokens', () => {
    assert.equal(estTokens({ role: 'assistant', content: '' }), 0);
  });
});

describe('provideTokenCount', () => {
  test('estimates a plain string at ~4 chars per token', async () => {
    assert.equal(await provider.provideTokenCount({} as any, 'a'.repeat(40), fakeToken()), 10);
  });

  test('walks a message object and budgets image parts', async () => {
    const { vscode } = await import('./vscodeRuntime');
    const model = {} as any;
    const textOnly = await provider.provideTokenCount(
      model,
      { content: [new vscode.LanguageModelTextPart('a'.repeat(400))] } as any,
      fakeToken()
    );
    assert.equal(textOnly, 100);

    const withImage = await provider.provideTokenCount(
      model,
      {
        content: [
          new vscode.LanguageModelTextPart('a'.repeat(400)),
          { mimeType: 'image/png', data: new Uint8Array(500_000) },
        ],
      } as any,
      fakeToken()
    );
    assert.equal(withImage, 100 + 150, 'image adds the fixed 150-token budget, not its bytes');
  });

  test('an empty message costs nothing', async () => {
    assert.equal(await provider.provideTokenCount({} as any, { content: [] } as any, fakeToken()), 0);
  });
});

// ---------------------------------------------------------------------------
// Orphan pruning
// ---------------------------------------------------------------------------

describe('pruneOrphanedToolMessages', () => {
  const prune = (messages: unknown[]) => invoke<any[]>(provider, 'pruneOrphanedToolMessages', messages);
  const assistantCall = (id: string, content: string | null = null) => ({
    role: 'assistant',
    content,
    tool_calls: [{ id, type: 'function', function: { name: 'f', arguments: '{}' } }],
  });
  const toolResult = (id: string, content = 'ok') => ({ role: 'tool', tool_call_id: id, content });

  test('keeps a matched assistant/tool pair', () => {
    const out = prune([assistantCall('a'), toolResult('a')]);
    assert.equal(out.length, 2);
  });

  test('drops a tool result whose assistant message is gone', () => {
    const out = prune([{ role: 'user', content: 'q' }, toolResult('ghost')]);
    assert.deepEqual(out.map((m) => m.role), ['user']);
  });

  test('drops the whole assistant message when it has no content and no kept calls', () => {
    const out = prune([assistantCall('a'), { role: 'user', content: 'next' }]);
    assert.deepEqual(out.map((m) => m.role), ['user']);
  });

  test('keeps an assistant message that has prose even when its call is orphaned', () => {
    const out = prune([assistantCall('a', 'thinking out loud')]);
    assert.equal(out.length, 1);
    assert.equal(out[0].content, 'thinking out loud');
    assert.equal('tool_calls' in out[0], false, 'an empty tool_calls array must be omitted, not sent as []');
  });

  test('keeps only the calls whose results survived', () => {
    const both = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'keep', type: 'function', function: { name: 'f', arguments: '{}' } },
        { id: 'drop', type: 'function', function: { name: 'g', arguments: '{}' } },
      ],
    };
    const out = prune([both, toolResult('keep')]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].tool_calls.map((c: any) => c.id), ['keep']);
  });

  test('leaves plain conversation messages untouched', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    assert.deepEqual(prune(msgs), msgs);
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe('truncateMessagesToFit', () => {
  const truncate = (messages: unknown[], maxTokens: number) => invoke<any[]>(provider, 'truncateMessagesToFit', messages, maxTokens);
  const msg = (role: string, size: number, marker = 'x'): Record<string, unknown> => ({
    role,
    content: `${marker}-${'y'.repeat(size * 4)}`,
  });

  test('returns the conversation untouched when it already fits', () => {
    const msgs = [msg('system', 10, 's'), msg('user', 20, 'u')];
    assert.deepEqual(truncate(msgs, 10_000), msgs);
  });

  test('keeps the system prompt and the newest messages, dropping the middle', () => {
    const msgs = [
      msg('system', 5, 'sys'),
      msg('user', 50, 'old1'),
      msg('assistant', 50, 'old2'),
      msg('user', 50, 'old3'),
      msg('user', 30, 'newest'),
    ];
    const out = truncate(msgs, 120);
    assert.equal(out[0].content, msgs[0].content, 'system prompt is always kept');
    assert.equal(out[out.length - 1].content, msgs[4].content, 'the newest message is kept');
    assert.ok(out.length < msgs.length);
    assert.ok(!out.some((m) => String(m.content).includes('old1')), 'oldest middle messages go first');
  });

  test('prunes tool pairs broken apart by truncation', () => {
    // The assistant tool_calls message is older than the budget allows, so its
    // tool result must be dropped with it (vLLM/llama.cpp reject orphans).
    const msgs = [
      msg('system', 5, 'sys'),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'z'.repeat(200 * 4) },
      msg('user', 10, 'newest'),
    ];
    const out = truncate(msgs, 60);
    const roles = out.map((m) => m.role);
    if (roles.includes('tool')) {
      assert.ok(roles.includes('assistant'), 'a surviving tool result needs its assistant message');
    }
    if (roles.includes('assistant')) {
      assert.ok(roles.includes('tool'), 'a surviving tool call needs its result');
    }
  });

  test('KNOWN LIMITATION: a newest message larger than the budget leaves only the system prompt', () => {
    // Characterization test, not an endorsement: today the backward scan stops
    // at the first message that does not fit, so one oversized tool result
    // (a big file read) drops the user's actual question and ships the system
    // prompt alone. Fixing this needs per-message content clamping; update this
    // test when that lands.
    const msgs = [msg('system', 5, 'sys'), msg('user', 5000, 'huge')];
    const out = truncate(msgs, 100);
    assert.deepEqual(out.map((m) => m.role), ['system']);
  });
});

void run();

