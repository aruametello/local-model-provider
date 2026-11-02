/**
 * GatewayClient: SSE parsing, streamed tool-call accumulation, retry
 * classification, header building, context-length extraction and the full
 * /v1/chat/completions streaming path driven through a fake global fetch.
 */

import './vscodeRuntime'; // must precede ../src imports (installs the vscode stub)

import assert from 'node:assert/strict';
import { describe, test, run } from './harness';
import { invoke } from './vscodeRuntime';
import { GatewayClient, GatewayError, sanitizeLoneSurrogates } from '../src/client';
import type { GatewayConfig, OpenAIModel, OpenAIUsage } from '../src/types';

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    serverUrl: 'http://localhost:8000',
    apiKey: '',
    requestTimeout: 60000,
    enableToolCalling: true,
    parallelToolCalling: true,
    qwenToolLoopCompat: false,
    finalAnswerRetry: true,
    recoverMalformedToolCalls: true,
    includeUsageInStream: true,
    requestLogDirectory: '',
    requestLogMaxMb: 100,
    maxRetries: 0,
    retryDelayMs: 100,
    modelCacheTtlMs: 0,
    logLevel: 'error',
    visionModels: [],
    maxOutputTokens: 65536,
    ...overrides,
  };
}

function openaiModel(args?: string[]): OpenAIModel {
  return { id: 'm', object: 'model', created: 0, owned_by: 'x', status: args ? { args } : undefined };
}

/**
 * KNOWN QUIRK: several diagnostics in client.ts (retry backoff, unparseable SSE
 * chunk, post-data stream drop) call `console.*` directly, so they bypass both
 * `logSink` and the `logLevel` setting and would spam `npm test`. Capturing them
 * keeps the run readable and turns each one into an assertion.
 */
async function withCapturedConsole<T>(fn: () => Promise<T> | T): Promise<{ result?: T; error?: unknown; lines: string[] }> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    return { result: await fn(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

// ---------------------------------------------------------------------------
// extractContextLength (llama.cpp status.args)
// ---------------------------------------------------------------------------

describe('extractContextLength', () => {
  const extract = GatewayClient.extractContextLength;

  test('reads --ctx-size as separate args', () => {
    assert.equal(extract(openaiModel(['--host', '0.0.0.0', '--ctx-size', '16384'])), 16384);
  });

  test('reads --ctx-size=<n> as a single token', () => {
    assert.equal(extract(openaiModel(['--ctx-size=32768'])), 32768);
  });

  test('prefers an explicit context_length override over --ctx-size', () => {
    const model = openaiModel([
      '--ctx-size', '8192',
      '--override-kv', 'context_length=int:262144',
    ]);
    assert.equal(extract(model), 262144);
  });

  test('returns undefined when no args are reported', () => {
    assert.equal(extract(openaiModel()), undefined);
    assert.equal(extract(openaiModel([])), undefined);
  });

  test('returns undefined for an unrelated or non-positive value', () => {
    assert.equal(extract(openaiModel(['--n-gpu-layers', '99'])), undefined);
    assert.equal(extract(openaiModel(['--ctx-size', '0'])), undefined);
    assert.equal(extract(openaiModel(['--ctx-size', 'not-a-number'])), undefined);
  });

  test('does not treat a trailing --ctx-size with no value as a size', () => {
    assert.equal(extract(openaiModel(['--ctx-size'])), undefined);
  });
});

// ---------------------------------------------------------------------------
// sanitizeLoneSurrogates
// ---------------------------------------------------------------------------

describe('sanitizeLoneSurrogates', () => {
  test('leaves valid surrogate pairs (emoji) untouched', () => {
    const emoji = 'ok 🙂👨‍👩‍👧🚀';
    assert.equal(sanitizeLoneSurrogates(emoji), emoji);
  });

  test('replaces a trailing high surrogate with U+FFFD', () => {
    assert.equal(sanitizeLoneSurrogates('abc\uD83D'), 'abc\uFFFD');
  });

  test('replaces a leading low surrogate with U+FFFD', () => {
    assert.equal(sanitizeLoneSurrogates('\uDE00abc'), '\uFFFDabc');
  });

  test('replaces an orphan inside a valid pair sequence', () => {
    const broken = `a\uD83D\uDE00b\uDE00c`;
    const out = sanitizeLoneSurrogates(broken);
    assert.equal(out, 'a\uD83D\uDE00b\uFFFDc');
    // The result must contain no lone surrogate, so JSON.stringify cannot emit
    // a bare \uXXXX escape that strict server parsers reject.
    assert.doesNotThrow(() => JSON.parse(JSON.stringify({ t: out })));
    assert.ok(!/\\ud[89ab][0-9a-f]{2}/i.test(JSON.stringify(out)));
  });

  test('leaves a JSON-escapable BMP string unchanged', () => {
    assert.equal(sanitizeLoneSurrogates('héllo wörld — 日本語'), 'héllo wörld — 日本語');
  });
});

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

describe('isRetryableError', () => {
  const client = new GatewayClient(baseConfig());
  const check = (error: unknown, status?: number) => invoke<boolean>(client, 'isRetryableError', error, status);

  test('retries the documented status codes only', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      assert.equal(check(null, status), true, `${status} should retry`);
    }
    for (const status of [400, 401, 403, 404, 422]) {
      assert.equal(check(null, status), false, `${status} should not retry`);
    }
  });

  test('walks the cause chain of a Node fetch failure', () => {
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:8000'),
    });
    assert.equal(check(wrapped), true);
  });

  test('reads error.code when the message says nothing', () => {
    const err = Object.assign(new Error('boom'), { code: 'ETIMEDOUT' });
    assert.equal(check(err), true);
  });

  test('survives a non-string error.code without crashing', () => {
    const err = Object.assign(new Error('boom'), { code: 42 });
    assert.equal(check(err), false);
  });

  test('does not retry an unrelated error', () => {
    assert.equal(check(new Error('model does not support tools')), false);
    assert.equal(check(undefined), false);
  });

  test('terminates on a cyclic cause chain', () => {
    const a = new Error('alpha') as Error & { cause?: unknown };
    const b = new Error('beta') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    const started = Date.now();
    assert.equal(check(a), false);
    assert.ok(Date.now() - started < 1000, 'the visited-set guard must break the cycle');
  });

  test('terminates on a self-referencing cause', () => {
    const self = new Error('loop') as Error & { cause?: unknown };
    self.cause = self;
    assert.equal(check(self), false);
  });

  test('still finds a retryable error inside a cycle', () => {
    const a = new Error('wrapper') as Error & { cause?: unknown };
    const b = Object.assign(new Error('connect ECONNREFUSED')) as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    assert.equal(check(a), true);
  });

  // A very long finite chain exercises the same walk: if it ever becomes
  // quadratic or recursive this test slows down or blows the stack.
  test('walks a very long cause chain', () => {
    let head: Error & { cause?: unknown } = new Error('tail');
    for (let i = 0; i < 20000; i++) {
      head = Object.assign(new Error(`layer ${i}`), { cause: head });
    }
    const started = Date.now();
    assert.equal(check(head), false);
    assert.ok(Date.now() - started < 2000, 'the walk should finish promptly');
  });
});

describe('calculateBackoffDelay', () => {
  test('grows exponentially and is capped by maxDelayMs', () => {
    const client = new GatewayClient(baseConfig(), { baseDelayMs: 1000, maxDelayMs: 5000 });
    const d0 = invoke<number>(client, 'calculateBackoffDelay', 0);
    const d3 = invoke<number>(client, 'calculateBackoffDelay', 3);
    const d20 = invoke<number>(client, 'calculateBackoffDelay', 20);
    assert.ok(d0 >= 1000 && d0 <= 1300, `attempt 0 within base..base*1.3, got ${d0}`);
    assert.ok(d3 > d0, 'later attempts wait longer');
    assert.equal(d20, 5000, 'capped at maxDelayMs');
  });
});

// ---------------------------------------------------------------------------
// Streaming tool-call accumulation (by index, ids arriving late)
// ---------------------------------------------------------------------------

describe('streamed tool calls', () => {
  const client = new GatewayClient(baseConfig());
  const newState = () => invoke<any>(client, 'createToolCallState');

  test('accumulates argument fragments under the same index', () => {
    const state = newState();
    invoke(client, 'processToolCallDelta', { index: 0, id: 'c1', function: { name: 'search', arguments: '{"q":' } }, state);
    invoke(client, 'processToolCallDelta', { index: 0, function: { arguments: '"llm"}' } }, state);
    const done = invoke<any[]>(client, 'finalizeToolCalls', state);
    assert.equal(done.length, 1);
    assert.deepEqual(JSON.parse(done[0].arguments), { q: 'llm' });
    assert.equal(done[0].name, 'search');
  });

  test('keeps parallel calls on different indexes apart', () => {
    const state = newState();
    invoke(client, 'processToolCallDelta', { index: 0, id: 'a', function: { name: 'one', arguments: '{}' } }, state);
    invoke(client, 'processToolCallDelta', { index: 1, id: 'b', function: { name: 'two', arguments: '{}' } }, state);
    const done = invoke<any[]>(client, 'finalizeToolCalls', state);
    assert.deepEqual(done.map((t) => t.name), ['one', 'two']);
  });

  test('adopts an id that arrives after the name/arguments', () => {
    const state = newState();
    invoke(client, 'processToolCallDelta', { index: 0, function: { name: 'late', arguments: '{}' } }, state);
    const done = invoke<any[]>(client, 'finalizeToolCalls', state);
    assert.ok(done[0].id, 'a generated id is filled in');
    invoke(client, 'processToolCallDelta', { index: 0, id: 'real-id', function: {} }, state);
    assert.equal(state.toolCallsByIndex.get(0).name, 'late', 'a late id must not blank the name');
  });

  test('continues the previous call when a server never sends an index', () => {
    const state = newState();
    invoke(client, 'processToolCallDelta', { id: 'x', function: { name: 'f', arguments: ' {"a"' } }, state);
    invoke(client, 'processToolCallDelta', { function: { arguments: ':1}' } }, state);
    const done = invoke<any[]>(client, 'finalizeToolCalls', state);
    assert.equal(done.length, 1, 'must not split into two calls');
    assert.deepEqual(JSON.parse(done[0].arguments), { a: 1 });
  });

  test('starts a new call when an indexless delta carries a different id', () => {
    const state = newState();
    invoke(client, 'processToolCallDelta', { id: 'x', function: { name: 'f', arguments: '{}' } }, state);
    invoke(client, 'processToolCallDelta', { id: 'y', function: { name: 'g', arguments: '{}' } }, state);
    const done = invoke<any[]>(client, 'finalizeToolCalls', state);
    assert.equal(done.length, 2);
  });

  test('never emits an empty placeholder slot', () => {
    const state = newState();
    invoke(client, 'processToolCallDelta', { index: 0 }, state);
    assert.deepEqual(invoke<any[]>(client, 'finalizeToolCalls', state), []);
    assert.deepEqual(invoke<any[]>(client, 'getRemainingToolCalls', state), []);
  });

  test('finalizes once: getRemainingToolCalls does not repeat a call', () => {
    const state = newState();
    invoke(client, 'processToolCallDelta', { index: 0, id: 'c', function: { name: 'f', arguments: '{}' } }, state);
    assert.equal(invoke<any[]>(client, 'finalizeToolCalls', state).length, 1);
    assert.equal(invoke<any[]>(client, 'getRemainingToolCalls', state).length, 0);
  });

  test('supports the legacy function_call format', () => {
    const state = newState();
    invoke(client, 'processLegacyFunctionCall', { name: 'old', arguments: '{"a":1}' }, 'req-1', state);
    const done = invoke<any[]>(client, 'finalizeToolCalls', state);
    assert.equal(done[0].name, 'old');
    assert.equal(done[0].id, 'req-1');
  });
});

// ---------------------------------------------------------------------------
// SSE line handling
// ---------------------------------------------------------------------------

describe('processSSELine', () => {
  const client = new GatewayClient(baseConfig());
  const feed = (line: string, state?: any) => invoke<any>(client, 'processSSELine', line, state ?? invoke<any>(client, 'createToolCallState'));

  test('ignores blanks, [DONE] and non-data lines', () => {
    assert.equal(feed(''), null);
    assert.equal(feed('data: [DONE]'), null);
    assert.equal(feed(': keep-alive'), null);
    assert.equal(feed('event: message'), null);
  });

  test('extracts content and reasoning from a delta', () => {
    const out = feed('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi', reasoning_content: 'hm' } }] }));
    assert.equal(out.content, 'hi');
    assert.equal(out.reasoning_content, 'hm');
  });

  test('accepts reasoning/thinking field aliases', () => {
    assert.equal(feed('data: ' + JSON.stringify({ choices: [{ delta: { reasoning: 'r' } }] })).reasoning_content, 'r');
    assert.equal(feed('data: ' + JSON.stringify({ choices: [{ delta: { thinking: 't' } }] })).reasoning_content, 't');
  });

  test('captures the trailing usage-only chunk with an empty choices array', () => {
    const usage: OpenAIUsage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
    const out = feed('data: ' + JSON.stringify({ choices: [], usage }));
    assert.deepEqual(out.usage, usage);
    assert.equal(out.content, '');
  });

  test('reads the non-delta message format', () => {
    const out = feed('data: ' + JSON.stringify({ choices: [{ message: { content: 'final' } }] }));
    assert.equal(out.content, 'final');
  });

  test('reports finish_reason and finalizes tool calls on tool_calls', () => {
    const state = invoke<any>(client, 'createToolCallState');
    feed('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{}' } }] } }] }), state);
    const done = feed('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), state);
    assert.equal(done.finish_reason, 'tool_calls');
    assert.equal(done.finished_tool_calls.length, 1);
    // A second finalize must not re-emit the same call.
    const again = feed('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), state);
    assert.equal(again.finished_tool_calls.length, 0);
  });

  test('survives a malformed JSON chunk without throwing', async () => {
    const { result, error, lines } = await withCapturedConsole(() => feed('data: {not json'));
    assert.equal(error, undefined, 'a bad chunk must not reject the stream');
    assert.equal(result, null);
    assert.ok(lines.some((l) => l.includes('Failed to parse SSE chunk')), 'the bad chunk is reported');
  });
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

describe('getHeaders', () => {
  const headers = (apiKey: string) => invoke<Record<string, string>>(new GatewayClient(baseConfig({ apiKey })), 'getHeaders');

  test('sends no Authorization header when the key is empty', () => {
    assert.equal(headers('').Authorization, undefined);
    assert.equal(headers('')['x-api-key'], undefined);
  });

  // A whitespace-only key must count as no key: the guard trims before
  // deciding, so an empty Bearer credential never reaches the wire.
  test('a whitespace-only key is treated as no key at all', () => {
    assert.equal(headers('   ').Authorization, undefined);
    assert.equal(headers('   ')['x-api-key'], undefined);
  });

  test('surrounding whitespace on a real key is trimmed, not sent', () => {
    assert.equal(headers('  sk-secret  ').Authorization, 'Bearer sk-secret');
    assert.equal(headers('  sk-secret  ')['x-api-key'], 'sk-secret');
  });

  test('adds the Bearer scheme when the key has none', () => {
    assert.equal(headers('secret')['Authorization'], 'Bearer secret');
  });

  test('does not double the Bearer prefix', () => {
    assert.equal(headers('Bearer already')['Authorization'], 'Bearer already');
    assert.equal(headers('bearer lower')['Authorization'], 'bearer lower');
  });

  test('always advertises JSON Accept', () => {
    assert.equal(headers('')['Accept'], 'application/json');
  });
});

// ---------------------------------------------------------------------------
// fetchModels against a fake fetch
// ---------------------------------------------------------------------------

describe('fetchModels', () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const withFetch = (impl: any, fn: () => Promise<void>) => async () => {
    (globalThis as any).fetch = impl;
    try {
      await fn();
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  };

  test(
    'GETs <serverUrl>/v1/models and returns the payload',
    withFetch(
      async (url: string) => {
        calls.push(String(url));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ object: 'list', data: [{ id: 'alpha', object: 'model', created: 0, owned_by: '' }] }),
        };
      },
      async () => {
        calls.length = 0;
        const models = await new GatewayClient(baseConfig()).fetchModels();
        assert.equal(calls[0], 'http://localhost:8000/v1/models');
        assert.equal(models.data[0].id, 'alpha');
      }
    )
  );

  test(
    'wraps a non-OK response in a GatewayError carrying the status',
    withFetch(
      async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => 'no route' }),
      async () => {
        await assert.rejects(
          () => new GatewayClient(baseConfig()).fetchModels(),
          (error: unknown) => {
            assert.ok(error instanceof GatewayError);
            assert.equal((error as GatewayError).statusCode, 404);
            assert.equal((error as GatewayError).isRetryable, false);
            assert.match((error as Error).message, /no route/);
            return true;
          }
        );
      }
    )
  );

  test('retries a refused connection, then reports the attempts in the final error', async () => {
    let attempts = 0;
    await withFetch(
      async () => {
        attempts++;
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        });
      },
      async () => {
        // Tiny backoff so the retry loop costs microseconds, not seconds.
        const client = new GatewayClient(baseConfig(), { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 });
        const { error, lines } = await withCapturedConsole(() => client.fetchModels());
        assert.ok(error instanceof GatewayError);
        assert.match((error as Error).message, /failed after 3 attempts/);
        // fetchWithRetry carries the real classification through: a network
        // failure whose retries are exhausted stays retryable, so callers and
        // crash logs can tell "server was down" from "request was invalid".
        assert.equal((error as GatewayError).isRetryable, true);
        assert.equal(
          lines.filter((l) => /retrying in [\d.]+ms/.test(l)).length,
          2,
          'one retry line per attempt that was retried'
        );
        assert.equal(attempts, 3, 'the first attempt plus two retries');
      }
    )();
  });

  test(
    'fetchOllamaCapabilities returns {} for non-Ollama servers',
    withFetch(
      async () => {
        throw new TypeError('fetch failed');
      },
      async () => {
        assert.deepEqual(await new GatewayClient(baseConfig()).fetchOllamaCapabilities(), {});
      }
    )
  );

  test(
    'fetchOllamaCapabilities indexes models by name',
    withFetch(
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'llava:7b', capabilities: ['vision', 'tools'] }, { name: 'qwen3' }] }),
      }),
      async () => {
        const caps = await new GatewayClient(baseConfig()).fetchOllamaCapabilities();
        assert.deepEqual(caps['llava:7b'], ['vision', 'tools']);
        assert.deepEqual(caps['qwen3'], []);
      }
    )
  );
});

// ---------------------------------------------------------------------------
// streamChatCompletion, end to end
// ---------------------------------------------------------------------------

function sseResponse(chunks: string[]): any {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
  return { ok: true, status: 200, statusText: 'OK', body };
}

function tokenChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

describe('streamChatCompletion', () => {
  const realFetch = globalThis.fetch;

  async function collect(client: GatewayClient, request: any, chunks: string[], options: { capture?: (url: string, init: any) => void } = {}) {
    let captured: any;
    (globalThis as any).fetch = async (url: string, init: any) => {
      captured = { url, init };
      options.capture?.(url, init);
      return sseResponse(chunks);
    };
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as any;
    try {
      const out: any[] = [];
      for await (const chunk of client.streamChatCompletion(request, token)) {
        out.push(chunk);
      }
      return { chunks: out, request: JSON.parse(captured.init.body), body: captured.init.body, url: captured.url, headers: captured.init.headers };
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  }

  test('POSTs to /v1/chat/completions, forces stream and requests usage', async () => {
    const result = await collect(new GatewayClient(baseConfig()), { model: 'm', messages: [] }, [tokenChunk('x')]);
    assert.equal(result.url, 'http://localhost:8000/v1/chat/completions');
    assert.equal(result.request.stream, true);
    assert.deepEqual(result.request.stream_options, { include_usage: true });
    assert.equal(result.headers['Content-Type'], 'application/json');
  });

  test('omits stream_options when includeUsageInStream is off', async () => {
    const result = await collect(new GatewayClient(baseConfig({ includeUsageInStream: false })), { model: 'm', messages: [] }, []);
    assert.equal(result.request.stream_options, undefined);
  });

  test('forces stream:true even if the caller forgot, and forwards other fields', async () => {
    const result = await collect(new GatewayClient(baseConfig()), { model: 'm', messages: [], stream: false, max_tokens: 128 } as any, []);
    assert.equal(result.request.stream, true, 'a chat completion here must always stream');
    assert.equal(result.request.max_tokens, 128, 'budgeting decisions come from the provider');
  });

  test('reassembles content split across chunks and across TCP boundaries', async () => {
    // One SSE record, deliberately sliced at arbitrary byte boundaries so the
    // parser has to buffer an incomplete line across reads.
    const record = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello world' } }] })}\n\n`;
    const chunks = [record.slice(0, 18), record.slice(18, 41), `${record.slice(41)}data: [DONE]\n`];
    const result = await collect(new GatewayClient(baseConfig()), { model: 'm', messages: [] }, chunks);
    assert.equal(result.chunks.map((c) => c.content).join(''), 'Hello world');
  });

  test('handles CRLF line endings', async () => {
    const result = await collect(new GatewayClient(baseConfig()), { model: 'm', messages: [] }, [
      'data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"b"}}]}\r\n\r\n',
    ]);
    assert.equal(result.chunks.map((c) => c.content).join(''), 'ab');
  });

  test('collects the trailing usage chunk', async () => {
    const usage: OpenAIUsage = { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 };
    const result = await collect(new GatewayClient(baseConfig()), { model: 'm', messages: [] }, [
      tokenChunk('hi'),
      `data: ${JSON.stringify({ choices: [], usage })}\n\n`,
    ]);
    assert.deepEqual(result.chunks[result.chunks.length - 1].usage, usage);
  });

  test('yields structured tool calls accumulated across deltas', async () => {
    const result = await collect(new GatewayClient(baseConfig()), { model: 'm', messages: [] }, [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_time', arguments: '{"tz":' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"UTC"}' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    ]);
    const all = result.chunks.flatMap((c) => c.finished_tool_calls);
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'get_time');
    assert.deepEqual(JSON.parse(all[0].arguments), { tz: 'UTC' });
  });

  test('finalizes a tool call that never gets a finish_reason', async () => {
    const result = await collect(new GatewayClient(baseConfig()), { model: 'm', messages: [] }, [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{}' } }] } }] })}\n\n`,
    ]);
    const last = result.chunks[result.chunks.length - 1];
    assert.equal(last.finished_tool_calls[0].name, 'f', 'stream end must flush pending calls');
  });

  test('sanitizes lone surrogates in the outgoing body', async () => {
    const result = await collect(new GatewayClient(baseConfig()), {
      model: 'm',
      messages: [{ role: 'user', content: 'broken emoji \uD83D here' }],
    }, []);
    // The wire JSON must not contain a bare high-surrogate escape: strict
    // server parsers (e.g. nlohmann::json) reject those even though they are
    // valid JSON grammar.
    assert.ok(!/\\ud83d/i.test(result.body), `raw surrogate leaked to the wire: ${result.body}`);
    assert.equal(JSON.parse(result.body).messages[0].content, 'broken emoji \uFFFD here');
  });

  test('treats a drop after data arrived as end-of-stream', async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          c.enqueue(encoder.encode(tokenChunk('partial')));
        },
      }),
    });
    // Error the body only after the first chunk has been handed out: calling
    // `controller.error()` inside `start()` discards the already-queued chunk.
    const failLater = setTimeout(() => controller.error(new Error('terminated')), 5);
    try {
      const out: string[] = [];
      const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as any;
      const { error: failure, lines } = await withCapturedConsole(async () => {
        for await (const chunk of new GatewayClient(baseConfig()).streamChatCompletion({ model: 'm', messages: [] } as any, token)) {
          out.push(chunk.content);
        }
      });
      assert.equal(out.join(''), 'partial', 'content delivered before the drop still reaches the consumer');
      // Documented compatibility behaviour (AGENTS.md §5): once data has been
      // received, a dropped connection is logged and treated as end-of-stream,
      // so the chat finishes with the partial answer instead of failing.
      assert.equal(failure, undefined, 'a post-data drop must not reject the stream');
      assert.ok(
        lines.some((l) => l.includes('Stream read interrupted after receiving data')),
        'the drop is logged, not swallowed'
      );
    } finally {
      clearTimeout(failLater);
      (globalThis as any).fetch = realFetch;
    }
  });

  test('surfaces a connection drop before any data as an error', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: new ReadableStream<Uint8Array>({ start(c) { c.error(new Error('socket hang up')); } }),
    });
    try {
      const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as any;
      await assert.rejects(
        async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _ of new GatewayClient(baseConfig()).streamChatCompletion({ model: 'm', messages: [] } as any, token)) { /* drain */ }
        },
        (error: unknown) => {
          assert.ok(error instanceof GatewayError);
          assert.match((error as Error).message, /terminated by the server/);
          return true;
        }
      );
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  test('rejects invalid UTF-8 instead of silently replacing bytes', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([0xff, 0xfe, 0x00]));
          c.close();
        },
      }),
    });
    try {
      const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as any;
      await assert.rejects(
        async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _ of new GatewayClient(baseConfig()).streamChatCompletion({ model: 'm', messages: [] } as any, token)) { /* drain */ }
        },
        /invalid UTF-8/
      );
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  test('reports cancellation cleanly when the token fires mid-stream', async () => {
    const source = new (class {
      cancelled = false;
      token = {
        isCancellationRequested: false,
        onCancellationRequested: (h: () => unknown) => {
          this.handlers.push(h);
          return { dispose() {} };
        },
      };
      handlers: Array<() => unknown> = [];
      fire(): void {
        this.cancelled = true;
        this.token.isCancellationRequested = true;
        for (const h of this.handlers) { h(); }
      }
    })();

    const encoder = new TextEncoder();
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode(tokenChunk('first ')));
          source.fire();
          c.close();
        },
      }),
    });
    try {
      const out: string[] = [];
      for await (const chunk of new GatewayClient(baseConfig()).streamChatCompletion({ model: 'm', messages: [] } as any, source.token as any)) {
        out.push(chunk.content);
      }
      // Cancellation stops the loop; it must not throw a misleading error.
      assert.ok(out.length <= 1);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});

void run();
