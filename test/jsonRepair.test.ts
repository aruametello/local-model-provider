/**
 * String-aware JSON repair (`src/provider.ts`).
 *
 * Local models truncate tool-call arguments mid-generation constantly, so the
 * repair path decides whether a tool call survives. The interesting failures
 * are the *silent* ones: a naive repair counts brackets that are inside string
 * values and happily corrupts a path like `a]b`, which is exactly what the
 * string-aware scanner exists to prevent.
 *
 * The `./vscodeRuntime` import MUST stay first: it installs the `Module._load`
 * hook that serves the `vscode` stub to `../src` modules.
 */
import './vscodeRuntime';

import * as assert from 'node:assert/strict';

import { describe, run, test } from './harness';
import { createProvider } from './providerFixture';
import { getOutputLines, invoke } from './vscodeRuntime';

function withProvider<T>(fn: (provider: any) => T): T {
  const { provider } = createProvider();
  return fn(provider);
}

const repair = (json: string) => withProvider((provider) => invoke(provider, 'tryRepairJson', json));
const balance = (json: string) => withProvider((provider) => invoke(provider, 'balanceBrackets', json));
const countChar = (str: string, char: string) =>
  withProvider((provider) => invoke<number>(provider, 'countCharOutsideStrings', str, char));
const countQuotes = (str: string) => withProvider((provider) => invoke<number>(provider, 'countQuotesOutsideEscapes', str));

// ---------------------------------------------------------------------------
// Low-level scanners
// ---------------------------------------------------------------------------

describe('countCharOutsideStrings', () => {
  test('counts structural characters only', () => {
    assert.equal(countChar('{"a":"b"}', '}'), 1);
    assert.equal(countChar('[[]]', ']'), 2);
  });

  test('ignores characters inside string values', () => {
    assert.equal(countChar('{"path":"a]b]c"}', ']'), 0);
    // Built with JSON.stringify so the escaping is unambiguous: the value is
    // `}{`, the only structural `}` is the one closing the object.
    assert.equal(countChar(JSON.stringify({ t: '}{' }), '}'), 1);
  });

  test('understands backslash escapes inside strings', () => {
    const value = JSON.stringify({ q: 'a "}" b' });
    assert.equal(countChar(value, '}'), 1, 'the escaped quotes must not desynchronise the scanner');
  });

  test('an unterminated string swallows the rest of the input', () => {
    // Characterisation: everything after an unclosed quote is treated as data.
    assert.equal(countChar('{"a":"oops } }', '}'), 0);
  });
});

describe('countQuotesOutsideEscapes', () => {
  test('counts quote characters that are not escaped', () => {
    assert.equal(countQuotes('"a"'), 2);
    assert.equal(countQuotes('\\"only escaped\\"'), 0);
    assert.equal(countQuotes('"a\\\\"'), 2, 'the escaped backslash must not eat the closing quote');
  });
});

describe('balanceBrackets', () => {
  test('closes what the model left open', () => {
    assert.equal(balance('{"a": [1, 2'), '{"a": [1, 2]}');
    assert.equal(balance('{"a": {"b": 1'), '{"a": {"b": 1}}');
  });

  test('never removes or adds for balanced input', () => {
    assert.equal(balance('{"a":[1,{"b":2}]}'), '{"a":[1,{"b":2}]}');
  });

  test('does not count brackets that live inside strings', () => {
    assert.equal(balance('{"path":"a]b"}'), '{"path":"a]b"}');
    assert.equal(balance('{"path":"a[[]b"}'), '{"path":"a[[]b"}');
  });

  test('leaves alone input with more closers than openers', () => {
    assert.equal(balance('{"a":1}}'), '{"a":1}}');
  });
});

// ---------------------------------------------------------------------------
// tryRepairJson
// ---------------------------------------------------------------------------

describe('tryRepairJson', () => {
  test('passes valid JSON straight through', () => {
    assert.deepEqual(repair('{"a":1,"b":[1,2,{"c":3}]}'), { a: 1, b: [1, 2, { c: 3 }] });
    assert.deepEqual(repair('  {"a":1}  '), { a: 1 });
  });

  test('treats an empty payload as an empty argument object', () => {
    assert.deepEqual(repair(''), {});
    assert.deepEqual(repair('   '), {});
  });

  test('closes a truncated object', () => {
    assert.deepEqual(repair('{"command": "ls -la"'), { command: 'ls -la' });
  });

  test('closes a truncated nested array', () => {
    assert.deepEqual(repair('{"files": ["a.ts", "b.ts"'), { files: ['a.ts', 'b.ts'] });
  });

  test('drops a trailing comma', () => {
    assert.deepEqual(repair('{"a": 1,}'), { a: 1 });
    assert.deepEqual(repair('{"a": [1, 2,],}'), { a: [1, 2] });
  });

  test('keeps commas and brackets that are part of string values', () => {
    assert.deepEqual(repair('{"path": "a]b",}'), { path: 'a]b' });
    assert.deepEqual(repair('{"csv": "x,y]}", }'), { csv: 'x,y]}' });
  });

  test('preserves escaped quotes inside values', () => {
    assert.deepEqual(repair('{"msg": "say \\"hi\\""}'), { msg: 'say "hi"' });
  });

  test('keeps unicode and emoji payloads intact', () => {
    assert.deepEqual(repair('{"t": "café \\u00e9 😀"}'), { t: 'café é 😀' });
  });

  test('returns null and logs when nothing can be salvaged', () => {
    assert.equal(repair('total garbage'), null);
    const lines = getOutputLines();
    assert.ok(lines.some((l) => l.startsWith('JSON repair failed')), 'the failure is logged for the user');
  });

  test('repairs a non-object payload (bare array)', () => {
    assert.deepEqual(repair('[1, 2'), [1, 2]);
  });

  // KNOWN QUIRK: the repair order balances braces BEFORE closing an unterminated
  // string, so the auto-inserted `}` lands inside the string value and the
  // result is parseable but carries the brace as data. Pinning it here so a
  // future reordering is a deliberate decision, not an accident.
  test('a value truncated mid-string yields a parseable but padded value', () => {
    assert.deepEqual(repair('{"path": "src/ma'), { path: 'src/ma}' });
  });
});

void run();
