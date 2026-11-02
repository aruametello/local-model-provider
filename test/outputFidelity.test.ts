/**
 * End-to-end OUTPUT FIDELITY: everything the model generates — backslashes in
 * Windows paths and scripts, escaped quotes, control characters, multibyte
 * Unicode — must reach the VS Code parts byte-for-byte.
 *
 * These tests drive the REAL pipeline (real GatewayProvider + real
 * GatewayClient SSE decoding) over a faked `fetch` that returns scripted SSE
 * bytes, so a regression anywhere between the wire and the reported parts
 * (JSON parse, UTF-8 decoding, SSE line handling, Qwen-XML buffering, part
 * conversion) shows up here. This is the INCOMING direction: the outgoing
 * body is guarded by `sanitizeLoneSurrogates` (see client.test.ts), incoming
 * text must never be rewritten at all.
 *
 * The `./providerFixture` import MUST stay first: it installs the `vscode`
 * stub before any `../src` module loads.
 */
import './providerFixture';

import * as assert from 'node:assert/strict';

import { describe, run, test } from './harness';
import { createProvider, fakeToken, progressSink } from './providerFixture';
import { vscode } from './vscodeRuntime';

const { LanguageModelTextPart, LanguageModelChatMessageRole } = vscode;

const realFetch = globalThis.fetch;

/** A realistic backslash-dense script: the exact content users complain about. */
const SCRIPT = [
  '@echo off',
  'set "PATH=C:\\Windows\\system32;C:\\Program Files\\Git\\bin"',
  'powershell -NoProfile -Command "Get-ChildItem -Path C:\\scripts\\*.ps1 | ForEach-Object { $_.FullName }"',
  'echo a JS string with a two-char escape: "first\\nsecond" and a regex: \\d+\\.\\d+',
  'exit /b %ERRORLEVEL%',
].join('\r\n');

function dataLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function contentChunk(text: string): string {
  return dataLine({ choices: [{ delta: { content: text } }] });
}

function modelInfo(): any {
  return {
    id: 'fidelity-model',
    name: 'fidelity-model',
    family: 'custom-local-model-provider',
    version: '1',
    maxInputTokens: 131072,
    maxOutputTokens: 131072,
    capabilities: {},
  };
}

function userMessage(text: string): any {
  return { role: LanguageModelChatMessageRole.User, content: [new LanguageModelTextPart(text)] };
}

/**
 * Runs one full chat request against scripted SSE bytes and returns
 * everything the provider reported through the progress sink.
 */
async function chatWithBody(body: ReadableStream<Uint8Array>, settings: Record<string, unknown> = {}) {
  const { provider } = createProvider(settings);
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, statusText: 'OK', body });
  const sink = progressSink();
  try {
    await provider.provideLanguageModelChatResponse(modelInfo(), [userMessage('hi')], {} as any, sink as any, fakeToken());
  } finally {
    (globalThis as any).fetch = realFetch;
  }
  const text = sink.parts
    .filter((p) => p?.constructor?.name === 'LanguageModelTextPart')
    .map((p) => p.value)
    .join('');
  return { text, parts: sink.parts };
}

function byteStream(slices: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of slices) c.enqueue(s);
      c.close();
    },
  });
}

function textStream(slices: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return byteStream(slices.map((s) => encoder.encode(s)));
}

const DONE = 'data: [DONE]\n\n';

describe('generated scripts with backslashes survive the full pipeline', () => {
  test('a backslash-dense batch script arrives character-for-character', async () => {
    const { text } = await chatWithBody(textStream([contentChunk(SCRIPT), DONE]));
    assert.equal(text, SCRIPT);
  });

  test('streaming in tiny wire slices never fuses or eats backslashes', async () => {
    // Chop the SSE payload every 7 characters — escapes like \\ and \", and
    // whole JSON lines, straddle the chunk boundaries.
    const wire = contentChunk(SCRIPT) + DONE;
    const slices: string[] = [];
    for (let i = 0; i < wire.length; i += 7) {
      slices.push(wire.slice(i, i + 7));
    }
    const { text } = await chatWithBody(textStream(slices));
    assert.equal(text, SCRIPT);
  });

  test('a two-character \\n inside generated code stays two characters', async () => {
    const code = 'print("hello\\nworld")  # newline is written as backslash-n';
    const { text } = await chatWithBody(textStream([contentChunk(code), DONE]));
    assert.equal(text, code);
    assert.ok(text.includes('\\n'), 'the literal two-char sequence must survive');
    assert.equal(text.indexOf('\n'), -1, 'it must NOT have been converted to a real newline');
  });

  test('hand-built JSON escape sequences decode to exactly the intended characters', async () => {
    // Raw wire bytes with hand-written escapes, independent of JSON.stringify:
    // this is what a real server actually sends.
    const raw =
      'data: {"choices":[{"delta":{"content":"tab:\\tquote:\\" crlf:\\r\\n path: C:\\\\scripts\\\\run.ps1"}}]}\n\n';
    const { text } = await chatWithBody(textStream([raw, DONE]));
    assert.equal(text, 'tab:\tquote:" crlf:\r\n path: C:\\scripts\\run.ps1');
  });
});

describe('multibyte output survives byte-level chunking', () => {
  test('an emoji split across two TCP chunks is reassembled, not replaced', async () => {
    const uni = 'ok: 😀 — ‹é› \u00e9\u0301 done';
    const wire = new TextEncoder().encode(contentChunk(uni) + DONE);
    const cut = wire.indexOf(0xf0) + 2; // inside the 4-byte U+1F600
    const { text } = await chatWithBody(byteStream([wire.slice(0, cut), wire.slice(cut)]));
    assert.equal(text, uni);
    assert.ok(!text.includes('\uFFFD'), 'the fatal decoder must not have silently replaced bytes');
  });

  test('a surrogate pair arriving split across SSE events stays one character', async () => {
    const pair = '\u{1F600}';
    // Send the emoji as ONE SSE event, but split its 4 UTF-8 bytes across reads.
    const line = new TextEncoder().encode(contentChunk('x' + pair + 'y'));
    const cut = line.indexOf(0xf0) + 3;
    const { text } = await chatWithBody(byteStream([line.slice(0, cut), line.slice(cut), new TextEncoder().encode(DONE)]));
    assert.equal(text, 'x' + pair + 'y');
    assert.equal(Array.from(text).length, 3, 'emoji counts as ONE code point');
  });

  test('a lone surrogate from the server is passed through unchanged (incoming is never rewritten)', async () => {
    // `\ud800` is legal JSON but an invalid Unicode scalar. Sanitization is
    // only for OUTGOING bodies; silently replacing inbound text would mangle
    // model output, so the surrogate must arrive untouched.
    const raw = 'data: {"choices":[{"delta":{"content":"emoji:\\ud83d\\ude00 broken:\\ud800 end"}}]}\n\n';
    const { text } = await chatWithBody(textStream([raw, DONE]));
    assert.equal(text, 'emoji:\u{1F600} broken:\uD800 end');
  });
});

describe('tool-call arguments keep their escapes', () => {
  test('Windows paths and nested quotes arrive fully parsed', async () => {
    const args = {
      path: 'C:\\scripts\\run.ps1',
      command: 'powershell -Command "Write-Host \'hi\'"',
      body: '{"json":"inside \\"quotes\\" and \\\\ backslash and \\n text"}',
    };
    const wire = dataLine({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_file', arguments: JSON.stringify(args) } }] },
        finish_reason: 'tool_calls',
      }],
    });
    const { parts } = await chatWithBody(textStream([wire, DONE]));
    const call = parts.find((p) => p?.name === 'write_file');
    assert.ok(call, 'the tool call must be reported');
    assert.deepEqual(call.input, args);
  });

  test('argument fragments split mid-escape still parse to the exact values', async () => {
    const args = { script: '$x = "C:\\a\\b"; $y = "line1`nline2"' };
    const inner = JSON.stringify(args);
    // Split the arguments string right after the first backslash byte.
    const bytes = new TextEncoder().encode(inner);
    const cut = bytes.indexOf(0x5c) + 1;
    const line1 = dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'write', arguments: '' } }] } }] });
    const fragments = [
      bytes.slice(0, cut),
      bytes.slice(cut),
    ];
    // Two SSE events carrying the two halves of the JSON-encoded arguments.
    const wrap = (b: Uint8Array) =>
      dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: new TextDecoder().decode(b) } }] } }] });
    const { parts } = await chatWithBody(textStream([line1, wrap(fragments[0]), wrap(fragments[1]), 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n', DONE]));
    const call = parts.find((p) => p?.name === 'write');
    assert.ok(call, 'the tool call must be reported');
    assert.deepEqual(call.input, args);
  });
});

describe('Qwen-XML compat mode does not disturb ordinary output', () => {
  test('backslash-heavy prose passes the tool-call buffer untouched', async () => {
    const { text } = await chatWithBody(textStream([contentChunk(SCRIPT), DONE]), { qwenToolLoopCompat: true });
    assert.equal(text, SCRIPT, 'a script without tool-call markers must not be buffered or rewritten');
  });

  test('backslashes inside a real XML tool-call parameter survive', async () => {
    const call = [
      '<tool_call>',
      '<function=write_file>',
      '<parameter=path>C:\\scripts\\run.ps1</parameter>',
      '<parameter=content>@echo off\r\necho "a\\" quote"\r\nset X=C:\\dir\\sub</parameter>',
      '</function>',
      '</tool_call>',
    ].join('\n');
    const { parts } = await chatWithBody(textStream([contentChunk(call), DONE]), { qwenToolLoopCompat: true });
    const tool = parts.find((p) => p?.name === 'write_file');
    assert.ok(tool, 'the XML call must become a structured tool call');
    assert.equal(tool.input.path, 'C:\\scripts\\run.ps1');
    assert.equal(tool.input.content, '@echo off\r\necho "a\\" quote"\r\nset X=C:\\dir\\sub');
  });
});

void run();
