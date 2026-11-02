/**
 * VS Code message/part conversion (`src/provider.ts`).
 *
 * This is the bridge that decides exactly what an OpenAI-compatible server
 * receives, so it is the highest-value place to pin behaviour: roles, tool
 * calls/results, multimodal image parts, and the duck-typed fallbacks that keep
 * older VS Code runtimes working.
 *
 * The `./vscodeRuntime` import MUST stay first: it installs the `Module._load`
 * hook that serves the `vscode` stub to `../src` modules.
 */
import './vscodeRuntime';

import * as assert from 'node:assert/strict';

import { describe, run, test } from './harness';
import { createProvider, progressSink } from './providerFixture';
import { getOutputLines, invoke, readPrivate, vscode, writePrivate } from './vscodeRuntime';

const { LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart, LanguageModelChatMessageRole } = vscode;

/** Runs `fn` with a provider built from `settings`. */
function withProvider<T>(settings: Record<string, unknown>, fn: (provider: any) => T): T {
  const { provider } = createProvider(settings);
  return fn(provider);
}

const mapRole = (provider: any, role: unknown) => invoke<string>(provider, 'mapRole', role);

const message = (role: unknown, content: unknown[]) => ({ role, content } as any);

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

describe('mapRole', () => {
  test('maps the two roles every VS Code version has', () => {
    withProvider({}, (provider) => {
      assert.equal(mapRole(provider, LanguageModelChatMessageRole.User), 'user');
      assert.equal(mapRole(provider, LanguageModelChatMessageRole.Assistant), 'assistant');
    });
  });

  test('maps System when the runtime exposes it', () => {
    withProvider({}, (provider) => {
      // Older @types/vscode has no System value, so the provider looks it up
      // dynamically; simulate a newer runtime.
      LanguageModelChatMessageRole.System = 3;
      try {
        assert.equal(mapRole(provider, 3), 'system');
      } finally {
        delete LanguageModelChatMessageRole.System;
      }
    });
  });

  test('collapses an unknown role into user rather than dropping the message', () => {
    withProvider({}, (provider) => {
      assert.equal(mapRole(provider, 99), 'user');
    });
  });
});

// ---------------------------------------------------------------------------
// Tool call / tool result parts
// ---------------------------------------------------------------------------

describe('convertToolCallPart', () => {
  test('produces an OpenAI function call with stringified arguments', () => {
    withProvider({}, (provider) => {
      const part = new LanguageModelToolCallPart('call-1', 'read_file', { path: 'a.ts', line: 3 });
      assert.deepEqual(invoke(provider, 'convertToolCallPart', part), {
        id: 'call-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.ts","line":3}' },
      });
    });
  });

  test('stringifies an empty input as an object, not as undefined', () => {
    withProvider({}, (provider) => {
      const out = invoke<Record<string, any>>(provider, 'convertToolCallPart', new LanguageModelToolCallPart('c', 'f', {}));
      assert.equal(out.function.arguments, '{}');
    });
  });
});

describe('convertToolResultPart', () => {
  test('keeps the answer verbatim when Qwen compat is off', () => {
    withProvider({ qwenToolLoopCompat: false }, (provider) => {
      const part = new LanguageModelToolResultPart('call-1', 'output text');
      assert.deepEqual(invoke(provider, 'convertToolResultPart', part), {
        tool_call_id: 'call-1',
        role: 'tool',
        content: 'output text',
      });
    });
  });

  test('appends the continue-the-loop hint when Qwen compat is on', () => {
    withProvider({ qwenToolLoopCompat: true }, (provider) => {
      const out = invoke<Record<string, string>>(provider, 'convertToolResultPart', new LanguageModelToolResultPart('c', 'out'));
      assert.ok(out.content.startsWith('out\n\n'), 'the original result stays first');
      assert.match(out.content, /Continue from the preserved reasoning/);
    });
  });

  test('serialises structured (non-string) result content', () => {
    withProvider({}, (provider) => {
      const out = invoke<Record<string, string>>(provider, 'convertToolResultPart', new LanguageModelToolResultPart('c', [{ any: 1 }]));
      assert.equal(out.content, '[{"any":1}]');
    });
  });
});

// ---------------------------------------------------------------------------
// Vision parts (duck-typed, never instanceof)
// ---------------------------------------------------------------------------

describe('extractImageContentPart', () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  test('converts an image data part to a base64 data URL', () => {
    withProvider({}, (provider) => {
      const out = invoke<Record<string, any>>(provider, 'extractImageContentPart', { mimeType: 'image/png', data: pngBytes });
      assert.deepEqual(out, { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBytes.toString('base64')}` } });
    });
  });

  test('ignores non-image and malformed data parts', () => {
    withProvider({}, (provider) => {
      assert.equal(invoke(provider, 'extractImageContentPart', { mimeType: 'application/pdf', data: pngBytes }), undefined);
      assert.equal(invoke(provider, 'extractImageContentPart', { mimeType: 'image/png' }), undefined, 'no payload');
      assert.equal(invoke(provider, 'extractImageContentPart', { data: pngBytes }), undefined, 'no mime');
      assert.equal(invoke(provider, 'extractImageContentPart', null), undefined);
      assert.equal(invoke(provider, 'extractImageContentPart', 'text'), undefined);
    });
  });

  test('accepts an image part whose class does not exist in this runtime', () => {
    withProvider({}, (provider) => {
      // A plain object with the right shape must work even without the
      // LanguageModelDataPart class (older VS Code).
      const out = invoke<Record<string, any>>(provider, 'extractImageContentPart', {
        mimeType: 'image/jpeg',
        data: Buffer.from('hi'),
      });
      assert.equal(out.image_url.url, `data:image/jpeg;base64,${Buffer.from('hi').toString('base64')}`);
    });
  });
});

// ---------------------------------------------------------------------------
// Duck-typed part fallbacks
// ---------------------------------------------------------------------------

describe('processPartDuckTyped', () => {
  const feed = (provider: any, part: unknown) => {
    const toolResults: any[] = [];
    const toolCalls: any[] = [];
    invoke(provider, 'processPartDuckTyped', part, toolResults, toolCalls);
    return { toolResults, toolCalls };
  };

  test('recognises a tool result by callId + content', () => {
    withProvider({}, (provider) => {
      const { toolResults, toolCalls } = feed(provider, { callId: 'c1', content: 'done' });
      assert.equal(toolCalls.length, 0);
      assert.deepEqual(toolResults, [{ tool_call_id: 'c1', role: 'tool', content: 'done' }]);
    });
  });

  test('recognises a tool call by callId + name + input', () => {
    withProvider({}, (provider) => {
      const { toolResults, toolCalls } = feed(provider, { callId: 'c1', name: 'f', input: { a: 1 } });
      assert.equal(toolResults.length, 0);
      assert.deepEqual(toolCalls, [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }]);
    });
  });

  test('silently ignores unrelated parts', () => {
    withProvider({}, (provider) => {
      const { toolResults, toolCalls } = feed(provider, { something: 'else' });
      assert.deepEqual([toolResults, toolCalls], [[], []]);
    });
  });
});

// ---------------------------------------------------------------------------
// Whole-message conversion
// ---------------------------------------------------------------------------

describe('convertSingleMessageWithLogging', () => {
  const convert = (provider: any, msg: any) => invoke<Record<string, unknown>[]>(provider, 'convertSingleMessageWithLogging', msg);

  test('plain user text stays a string', () => {
    withProvider({}, (provider) => {
      assert.deepEqual(convert(provider, message(LanguageModelChatMessageRole.User, [new LanguageModelTextPart('hello')])), [
        { role: 'user', content: 'hello' },
      ]);
    });
  });

  test('concatenates several text parts into one message', () => {
    withProvider({}, (provider) => {
      const out = convert(provider, message(LanguageModelChatMessageRole.User, [
        new LanguageModelTextPart('one '),
        new LanguageModelTextPart('two'),
      ]));
      assert.equal(out[0].content, 'one two');
    });
  });

  test('an assistant message with no content sends null, not an empty string', () => {
    withProvider({}, (provider) => {
      const out = convert(provider, message(LanguageModelChatMessageRole.Assistant, []));
      assert.deepEqual(out, []);
      const withCall = convert(provider, message(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart('c1', 'f', {}),
      ]));
      assert.equal(withCall[0].content, null, 'tool-call-only assistant turns must have null content');
    });
  });

  test('emits a multimodal content array (text first) when images are present', () => {
    withProvider({}, (provider) => {
      const data = Buffer.from([1, 2, 3]);
      const out = convert(provider, message(LanguageModelChatMessageRole.User, [
        new LanguageModelTextPart('what is this?'),
        { mimeType: 'image/png', data },
      ]));
      assert.equal(out.length, 1);
      assert.deepEqual(out[0].content, [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${data.toString('base64')}` } },
      ]);
    });
  });

  test('image-only message omits the empty text entry', () => {
    withProvider({}, (provider) => {
      const out = convert(provider, message(LanguageModelChatMessageRole.User, [{ mimeType: 'image/png', data: Buffer.from([9]) }]));
      assert.equal((out[0].content as unknown[]).length, 1);
    });
  });

  test('tool calls become one assistant message, tool results become one message each', () => {
    withProvider({}, (provider) => {
      const calls = convert(provider, message(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart('c1', 'f', { a: 1 }),
        new LanguageModelToolCallPart('c2', 'g', {}),
      ]));
      assert.equal(calls.length, 1, 'parallel calls share one assistant turn');
      assert.equal((calls[0].tool_calls as unknown[]).length, 2);

      const results = convert(provider, message(LanguageModelChatMessageRole.User, [
        new LanguageModelToolResultPart('c1', 'r1'),
        new LanguageModelToolResultPart('c2', 'r2'),
      ]));
      assert.deepEqual(results.map((r) => r.tool_call_id), ['c1', 'c2']);
      assert.deepEqual(results.map((r) => r.role), ['tool', 'tool']);
    });
  });

  test('a message with both a tool call and text keeps the text', () => {
    withProvider({}, (provider) => {
      const out = convert(provider, message(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelTextPart('thinking out loud'),
        new LanguageModelToolCallPart('c1', 'f', {}),
      ]));
      assert.equal(out[0].content, 'thinking out loud');
    });
  });

  test('Qwen compat prefixes the preserved reasoning into the assistant turn', () => {
    withProvider({ qwenToolLoopCompat: true }, (provider) => {
      writePrivate(provider, 'toolCallReasoning', new Map([['c1', '  I will read the file  ']]));
      const out = convert(provider, message(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelTextPart('calling now'),
        new LanguageModelToolCallPart('c1', 'read', {}),
      ]));
      assert.equal(out[0].content, '<think>\nI will read the file\n</think>\n\ncalling now');
    });
  });

  test('without stored reasoning the assistant content stays the plain text', () => {
    withProvider({ qwenToolLoopCompat: true }, (provider) => {
      const out = convert(provider, message(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart('unknown-id', 'read', {}),
      ]));
      assert.equal(out[0].content, null);
    });
  });
});

// ---------------------------------------------------------------------------
// Schema defaults / required-property filling
// ---------------------------------------------------------------------------

describe('getDefaultForType', () => {
  const get = (schema: unknown) =>
    withProvider({}, (provider) => invoke(provider, 'getDefaultForType', schema));

  test('falls back per JSON type', () => {
    assert.equal(get({ type: 'string' }), '');
    assert.equal(get({ type: 'number' }), 0);
    assert.equal(get({ type: 'integer' }), 0);
    assert.equal(get({ type: 'boolean' }), false);
    assert.deepEqual(get({ type: 'array' }), []);
    assert.deepEqual(get({ type: 'object' }), {});
    assert.equal(get({ type: 'null' }), null);
  });

  test('honours an explicit schema default', () => {
    assert.equal(get({ type: 'string', default: 'auto' }), 'auto');
    assert.equal(get({ type: 'number', default: 7 }), 7);
  });

  test('handles union types', () => {
    assert.equal(get({ type: ['string', 'null'] }), null, 'null wins in a union');
    assert.equal(get({ type: ['null', 'string'] }), null);
    assert.deepEqual(get({ type: ['object', 'boolean'] }), {}, 'first non-null type wins');
    assert.equal(get({ type: [] }), null);
  });

  test('returns null for missing or unknown types', () => {
    assert.equal(get(undefined), null);
    assert.equal(get(null), null);
    assert.equal(get({}), null);
    assert.equal(get({ type: 'made-up' }), null);
  });
});

describe('fillMissingRequiredProperties', () => {
  const schema = {
    type: 'object',
    required: ['path', 'mode', 'depth'],
    properties: {
      path: { type: 'string' },
      mode: { type: 'string', default: 'rw' },
      depth: { type: 'integer' },
      optional: { type: 'string' },
    },
  };

  test('fills only the properties that are actually missing', () => {
    withProvider({}, (provider) => {
      const out = invoke<Record<string, unknown>>(provider, 'fillMissingRequiredProperties',
        { path: 'keep.ts' }, 'tool', schema);
      assert.deepEqual(out, { path: 'keep.ts', mode: 'rw', depth: 0 });
      assert.ok(getOutputLines().some((l) => l.includes('AUTO-FILLED')), 'the fill is logged');
    });
  });

  test('leaves arguments untouched when the schema has no required list', () => {
    withProvider({}, (provider) => {
      const args = { a: 1 };
      assert.deepEqual(invoke(provider, 'fillMissingRequiredProperties', args, 'tool', { properties: {} }), args);
      assert.deepEqual(invoke(provider, 'fillMissingRequiredProperties', args, 'tool', undefined), args);
    });
  });

  test('does not mutate the caller object', () => {
    withProvider({}, (provider) => {
      const args = {};
      invoke(provider, 'fillMissingRequiredProperties', args, 'tool', schema);
      assert.deepEqual(args, {});
    });
  });

  test('a required property without a schema entry becomes null', () => {
    withProvider({}, (provider) => {
      const out = invoke<Record<string, unknown>>(provider, 'fillMissingRequiredProperties',
        {}, 'tool', { required: ['mystery'], properties: {} });
      assert.deepEqual(out, { mystery: null });
    });
  });
});

// ---------------------------------------------------------------------------
// Outgoing tools config + streamed tool-call handling
// ---------------------------------------------------------------------------

describe('buildToolsConfig', () => {
  const tool = { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', required: ['path'] } };

  test('sends nothing when tool calling is disabled', () => {
    withProvider({ enableToolCalling: false }, (provider) => {
      assert.equal(invoke(provider, 'buildToolsConfig', { tools: [tool] }), undefined);
    });
  });

  test('sends nothing when the request has no tools', () => {
    withProvider({}, (provider) => {
      assert.equal(invoke(provider, 'buildToolsConfig', {}), undefined);
      assert.equal(invoke(provider, 'buildToolsConfig', { tools: [] }), undefined);
    });
  });

  test('maps tools to the OpenAI function shape and remembers schemas', () => {
    withProvider({}, (provider) => {
      const out = invoke<Record<string, any>[]>(provider, 'buildToolsConfig', { tools: [tool] });
      assert.deepEqual(out, [{
        type: 'function',
        function: { name: 'read_file', description: 'Read a file', parameters: tool.inputSchema },
      }]);
      assert.equal(readPrivate<Map<string, unknown>>(provider, 'currentToolSchemas').get('read_file'), tool.inputSchema);
    });
  });

  test('clears stale schemas between requests', () => {
    withProvider({}, (provider) => {
      invoke(provider, 'buildToolsConfig', { tools: [tool] });
      invoke(provider, 'buildToolsConfig', { tools: [{ name: 'other', description: '', inputSchema: {} }] });
      const schemas = readPrivate<Map<string, unknown>>(provider, 'currentToolSchemas');
      assert.equal(schemas.has('read_file'), false);
      assert.equal(schemas.size, 1);
    });
  });
});

describe('processToolCall', () => {
  const runCall = (provider: any, toolCall: { id: string; name: string; arguments: string }) => {
    const sink = progressSink();
    invoke(provider, 'processToolCall', toolCall, sink, '');
    return sink.parts;
  };

  test('reports a ToolCallPart with parsed arguments', () => {
    withProvider({}, (provider) => {
      const parts = runCall(provider, { id: 'c1', name: 'search', arguments: '{"q":"cats"}' });
      assert.equal(parts.length, 1);
      const part = parts[0];
      assert.equal(part.callId, 'c1');
      assert.equal(part.name, 'search');
      assert.deepEqual(part.input, { q: 'cats' });
    });
  });

  test('repairs truncated arguments instead of dropping the call', () => {
    withProvider({}, (provider) => {
      const parts = runCall(provider, { id: 'c1', name: 'f', arguments: '{"path":"src/' });
      assert.equal(typeof parts[0].input, 'object');
      assert.ok(parts[0].input.path, 'a path value should survive the repair');
    });
  });

  test('falls back to empty arguments when the payload is unrecoverable', () => {
    withProvider({}, (provider) => {
      const parts = runCall(provider, { id: 'c1', name: 'f', arguments: 'total garbage' });
      assert.deepEqual(parts[0].input, {});
    });
  });

  test('treats an empty argument string as no arguments', () => {
    withProvider({}, (provider) => {
      const parts = runCall(provider, { id: 'c1', name: 'f', arguments: '' });
      assert.deepEqual(parts[0].input, {});
    });
  });

  test('fills required properties from the schema seen in this request', () => {
    withProvider({}, (provider) => {
      invoke(provider, 'buildToolsConfig', {
        tools: [{ name: 'f', description: '', inputSchema: { required: ['path'], properties: { path: { type: 'string' } } } }],
      });
      const parts = runCall(provider, { id: 'c1', name: 'f', arguments: '{}' });
      assert.deepEqual(parts[0].input, { path: '' });
    });
  });

  test('keeps streamed reasoning for the follow-up turn only in Qwen mode', () => {
    const plain = withProvider({ qwenToolLoopCompat: false }, (provider) => {
      const sink = progressSink();
      invoke(provider, 'processToolCall', { id: 'c1', name: 'f', arguments: '{}' }, sink, 'some thinking');
      return readPrivate<Map<string, string>>(provider, 'toolCallReasoning').size;
    });
    assert.equal(plain, 0, 'no reasoning map growth outside Qwen compat');

    const qwen = withProvider({ qwenToolLoopCompat: true }, (provider) => {
      const sink = progressSink();
      invoke(provider, 'processToolCall', { id: 'c1', name: 'f', arguments: '{}' }, sink, '  some thinking  ');
      return readPrivate<Map<string, string>>(provider, 'toolCallReasoning').get('c1');
    });
    assert.equal(qwen, 'some thinking', 'trimmed reasoning is stored under the call id');
  });
});

void run();
