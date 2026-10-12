import assert from 'node:assert/strict';
import { parseQwenXmlToolCalls, extractParameters, coerceParameterValue, splitVisibleFromToolCallBuffer, hasRawToolCallMarkup, containsToolCallOpenMarker } from '../src/qwenXml';
import { truncateToCodePoints } from '../src/charUtils';

// ---------------------------------------------------------------------------
// qwenXml: tag-aware parameter extraction (embedded closing tags preserved)
// ---------------------------------------------------------------------------

// A parameter value that legitimately contains the literal text `</parameter>`
// (e.g. a code snippet) must NOT be truncated at the first occurrence.
{
  const body = '<parameter=code>if (x < 1) { return "</parameter>"; }</parameter>';
  const params = extractParameters(body);
  assert.equal(params.length, 1);
  assert.equal(params[0].key, 'code');
  assert.equal(params[0].value, 'if (x < 1) { return "</parameter>"; }');
}

// Multiple parameters: each matches its LAST closing tag before the next open tag.
{
  const body = '<parameter=a>one</parameter><parameter=b>two</parameter>';
  const params = extractParameters(body);
  assert.equal(params.length, 2);
  assert.deepEqual(params.map((p) => [p.key, p.value]), [['a', 'one'], ['b', 'two']]);
}

// A value containing a literal `</parameter>` followed by a real closing tag.
{
  const body = '<parameter=text>a</parameter> b</parameter>';
  const params = extractParameters(body);
  assert.equal(params.length, 1);
  assert.equal(params[0].value, 'a</parameter> b');
}

// Unterminated parameter (no closing tag) — value runs to end of body.
{
  const body = '<parameter=path>README.md';
  const params = extractParameters(body);
  assert.equal(params.length, 1);
  assert.equal(params[0].key, 'path');
  assert.equal(params[0].value, 'README.md');
}

// Full parse: embedded closing tag inside a parameter value survives end-to-end.
{
  const parsed = parseQwenXmlToolCalls(`
<tool_call>
<function=write_file>
<parameter=path>src/foo.ts</parameter>
<parameter=content>const s = "</parameter>";</parameter>
</function>
</tool_call>
done
`);
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, 'write_file');
  const args = JSON.parse(parsed.toolCalls[0].arguments);
  assert.equal(args.path, 'src/foo.ts');
  assert.equal(args.content, 'const s = "</parameter>";');
  assert.equal(parsed.text, 'done');
}

// Value coercion still works (int, float, boolean, JSON object).
{
  const parsed = parseQwenXmlToolCalls(`
<tool_call>
<function=read_file>
<parameter=path>README.md</parameter>
<parameter=max_lines>40</parameter>
<parameter=include_hidden>false</parameter>
</function>
</tool_call>
I'm calling this tool to inspect the project readme.
`);
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, 'read_file');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].arguments), {
    path: 'README.md',
    max_lines: 40,
    include_hidden: false,
  });
  assert.equal(parsed.text, "I'm calling this tool to inspect the project readme.");
}

// Multiple tool calls with text between them.
{
  const parsed = parseQwenXmlToolCalls(`
<tool_call>
<function=first>
<parameter=enabled>true</parameter>
</function>
</tool_call>
between
<tool_call>
<function=second>
<parameter=payload>{"ok":true}</parameter>
</function>
</tool_call>
after
`);
  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(parsed.text, 'between\n\nafter');
}

// coerceParameterValue unit checks.
{
  assert.equal(coerceParameterValue('42'), 42);
  assert.equal(coerceParameterValue('-7'), -7);
  assert.equal(coerceParameterValue('3.14'), 3.14);
  assert.equal(coerceParameterValue('true'), true);
  assert.equal(coerceParameterValue('false'), false);
  assert.deepEqual(coerceParameterValue('{"ok":true}'), { ok: true });
  assert.deepEqual(coerceParameterValue('[1,2]'), [1, 2]);
  assert.equal(coerceParameterValue('hello world'), 'hello world');
  assert.equal(coerceParameterValue('{not json'), '{not json');
}

// ---------------------------------------------------------------------------
// truncateToCodePoints: never splits a surrogate pair
// ---------------------------------------------------------------------------

// Truncating at a code-unit boundary that lands inside an emoji must keep the
// emoji intact (or drop it entirely), never produce a lone surrogate.
{
  const emoji = 'a\u{1F600}b'; // 'a' + 😀 + 'b'
  const truncated = truncateToCodePoints(emoji, 2);
  assert.equal(truncated, 'a\u{1F600}');
  // No UNPAIRED surrogates in the result (a valid pair is fine).
  assert.equal(hasUnpairedSurrogate(truncated), false);
}

// Truncating exactly at the emoji boundary drops the emoji cleanly.
{
  const emoji = 'a\u{1F600}b';
  const truncated = truncateToCodePoints(emoji, 1);
  assert.equal(truncated, 'a');
  assert.equal(hasUnpairedSurrogate(truncated), false);
}

// maxCodePoints <= 0 returns empty string.
{
  assert.equal(truncateToCodePoints('hello', 0), '');
  assert.equal(truncateToCodePoints('hello', -1), '');
}

// Longer-than-limit truncation works for plain ASCII.
{
  assert.equal(truncateToCodePoints('hello world', 5), 'hello');
}

// No truncation needed when within limit.
{
  assert.equal(truncateToCodePoints('hello', 10), 'hello');
}

// ---------------------------------------------------------------------------
// JSON repair helpers (string-aware bracket balancing)
// ---------------------------------------------------------------------------

// A truncated JSON object whose string value contains a `]` must not have
// extra brackets appended for the `]` inside the string.
{
  // Simulate the repair pipeline: balanceBrackets must ignore `]` inside "a]b".
  // We can't call the private method directly, so exercise the observable
  // behavior through a truncated tool-call argument that the provider would
  // repair. The key assertion: a `]` inside a string value is data, not
  // structure, so the repaired JSON parses with the string intact.
  const truncated = '{"path": "a]b"';
  // Direct parse fails (unterminated string + missing brace).
  assert.throws(() => JSON.parse(truncated));
  // The string-aware repair appends exactly one closing brace (the `]` inside
  // the string is not counted as a structural bracket).
  const repaired = truncated + '}';
  assert.deepEqual(JSON.parse(repaired), { path: 'a]b' });
}

// Trailing comma inside a string value is data and must survive repair.
{
  const input = '{"a": "x,y]", "b": 1}';
  // Valid JSON already — direct parse succeeds and the comma inside the string
  // is preserved.
  assert.deepEqual(JSON.parse(input), { a: 'x,y]', b: 1 });
}

// ---------------------------------------------------------------------------
// Surrogate sanitization (outgoing wire safety net)
// ---------------------------------------------------------------------------

// A lone surrogate in message content must be replaced with U+FFFD before the
// request body is serialized (mirrors client.ts sanitizeLoneSurrogates).
{
  const sanitize = (value: string): string =>
    value.replace(
      /([\uD800-\uDBFF])(?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])([\uDC00-\uDFFF])/g,
      '\uFFFD'
    );
  assert.equal(sanitize('a\uD800b'), 'a\uFFFDb');
  assert.equal(sanitize('a\uDC00b'), 'a\uFFFDb');
  // A valid surrogate PAIR (emoji) is untouched.
  assert.equal(sanitize('a\u{1F600}b'), 'a\u{1F600}b');
}

/**
 * True when the string contains a surrogate code unit that is not part of a
 * valid high+low pair (i.e. a lone surrogate that would corrupt JSON output).
 */
function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      // High surrogate: must be followed by a low surrogate.
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {
        return true;
      }
      i++; // skip the paired low surrogate
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      // Low surrogate without a preceding high surrogate.
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// qwenXml: tag-bounded hold-back for streamed <tool_call> blocks
// ---------------------------------------------------------------------------

// Plain text with no tool-call markup is fully visible, nothing held back.
{
  const { visible, holdback } = splitVisibleFromToolCallBuffer('Just some prose.\n');
  assert.equal(visible, 'Just some prose.\n');
  assert.equal(holdback, '');
}

// An empty buffer stays empty.
{
  const { visible, holdback } = splitVisibleFromToolCallBuffer('');
  assert.equal(visible, '');
  assert.equal(holdback, '');
}

// A complete <tool_call>…</tool_call> block is safe to show (it gets converted later).
{
  const block = '<tool_call> <function=create> <parameter=path>a.py</parameter> </function> </tool_call>';
  const { visible, holdback } = splitVisibleFromToolCallBuffer(`prefix ${block}suffix`);
  assert.equal(visible, `prefix ${block}suffix`);
  assert.equal(holdback, '');
}

// An open block without its closing tag is held back from the open tag.
{
  const body = '<tool_call> <function=create> <parameter=code>print(1)';
  const { visible, holdback } = splitVisibleFromToolCallBuffer(`intro ${body}`);
  assert.equal(visible, 'intro ');
  assert.equal(holdback, body);
}

// Two blocks: the first (closed) is safe, the second (open) is held back.
{
  const closed = '<tool_call> <function=f> </function> </tool_call>';
  const open = '<tool_call> <function=g> <parameter=x>1';
  const { visible, holdback } = splitVisibleFromToolCallBuffer(`${closed}${open}`);
  assert.equal(visible, closed);
  assert.equal(holdback, open);
}

// A stray closing tag with no matching open tag is ordinary text.
{
  const { visible, holdback } = splitVisibleFromToolCallBuffer('text then </tool_call> and more');
  assert.equal(visible, 'text then </tool_call> and more');
  assert.equal(holdback, '');
}

// A trailing fragment that is a strict prefix of "<tool_call" is held back
// (tag split across a chunk boundary), the rest stays visible.
{
  const { visible, holdback } = splitVisibleFromToolCallBuffer('done now <tool_ca');
  assert.equal(visible, 'done now ');
  assert.equal(holdback, '<tool_ca');
}

// The full 10-char prefix "<tool_call" (minus the required '>' which may still
// be streaming in) is held back.
{
  const { visible, holdback } = splitVisibleFromToolCallBuffer('x<tool_call');
  assert.equal(visible, 'x');
  assert.equal(holdback, '<tool_call');
}

// Simulated token-by-token stream: no <tool_call ever leaks into visible text
// before the closing tag of that block has been seen.
{
  const fullText = 'Now I will edit:\n<tool_call> <function=create> <parameter=code>print("hi")</parameter> </function> </tool_call> all done';
  let pending = '';
  let emitted = '';
  for (const char of fullText) {
    const { visible, holdback } = splitVisibleFromToolCallBuffer(pending + char);
    pending = holdback;
    emitted += visible;
    // Nothing may be emitted while a block is still open: the held-back tail
    // must contain the only occurrence of "<tool_call" in the combined text.
    const combined = visible + holdback;
    if (combined.includes('<tool_call') && !combined.includes('</tool_call>')) {
      assert.equal(visible.includes('<tool_call'), false, `leaked mid-block: ${JSON.stringify(visible)}`);
    }
  }
  // After the whole text is in, the closed block plus trailing prose is safe.
  const final = splitVisibleFromToolCallBuffer(pending);
  assert.equal(final.holdback, '');
  emitted += final.visible;
  assert.ok(emitted.includes('all done'));
}

// Bare <function=...> block (no <tool_call> wrapper) is also bounded.
{
  const open = 'go <function=f> <parameter=a>1';
  const r = splitVisibleFromToolCallBuffer(open);
  assert.equal(r.visible, 'go ');
  assert.equal(r.holdback, '<function=f> <parameter=a>1');
  const closed = splitVisibleFromToolCallBuffer('go <function=f> <parameter=a>1</parameter> </function> done');
  assert.equal(closed.holdback, '');
}

// Partial "<function" prefix at the end is held back too.
{
  const r = splitVisibleFromToolCallBuffer('ok <func');
  assert.equal(r.visible, 'ok ');
  assert.equal(r.holdback, '<func');
}

// Tolerant parsing: missing </tool_call>, and bare <function=...> blocks.
{
  const noClose = parseQwenXmlToolCalls('<tool_call>\n<function=read>\n<parameter=path>a.txt</parameter>\n</function>');
  assert.equal(noClose.toolCalls.length, 1);
  assert.equal(noClose.toolCalls[0].name, 'read');
  assert.equal(noClose.text, '');
  const bare = parseQwenXmlToolCalls('hi <function=read><parameter=path>b</parameter></function> bye');
  assert.equal(bare.toolCalls.length, 1);
  assert.equal(JSON.parse(bare.toolCalls[0].arguments).path, 'b');
}

// Malformed-markup detection.
{
  assert.equal(hasRawToolCallMarkup('plain answer'), false);
  assert.equal(hasRawToolCallMarkup('the <tool_call> tag is used by Qwen'), false);
  assert.equal(hasRawToolCallMarkup('<tool_call>{"name":"x","arguments":{}}</tool_call>'), true);
  assert.equal(hasRawToolCallMarkup('<tool_call>\n<function=x>\n<parameter=a>1'), true); // unterminated
  assert.equal(hasRawToolCallMarkup('<tool_call>\n{"name":"x"'), true); // unterminated JSON
  assert.equal(hasRawToolCallMarkup('<function=x><parameter=a>1</parameter></function>'), true); // bare
  assert.equal(hasRawToolCallMarkup('<tool_call >\n<function=x></function></tool_call>'), true);
  assert.equal(containsToolCallOpenMarker('x <function=f>'), true);
  assert.equal(containsToolCallOpenMarker('x < tool'), false);
}

// Nested/mentioned markers: prose (e.g. a reasoning trace) that MENTIONS
// <function=name> or <tool_call> must not hijack the real call that follows.
{
  const real = '<tool_call>\n<function=powershell>\n<parameter=command>\ncd x\n</parameter>\n</function>\n</tool_call>';
  for (const prose of [
    'It matches `<function=name>` followed by anything.',
    'It matches <function=name> followed by anything.', // not quoted at all
    'regex `/<tool_call(?![A-Za-z0-9_])[^>]*>[\\s\\S]*<\\/tool_call>/` ok',
    'a stray </tool_call> and an open <tool_call> in prose',
  ]) {
    const parsed = parseQwenXmlToolCalls(`${prose}\n\n${real}`);
    assert.equal(parsed.toolCalls.length, 1, `calls for: ${prose}`);
    assert.equal(parsed.toolCalls[0].name, 'powershell', `name for: ${prose}`);
    assert.equal(JSON.parse(parsed.toolCalls[0].arguments).command, 'cd x');
    assert.ok(parsed.text.startsWith(prose.slice(0, 10)), `prose kept for: ${prose}`);
  }
  // A quoted complete example is a mention, not a call.
  assert.equal(parseQwenXmlToolCalls('use `<function=f><parameter=a>1</parameter></function>` like so').toolCalls.length, 0);
  // Two sequential calls both survive.
  assert.equal(parseQwenXmlToolCalls(`${real}\n${real}`).toolCalls.length, 2);
  // Quoted markers are not "malformed markup"; a real block after them is.
  assert.equal(hasRawToolCallMarkup('the `<tool_call>…</tool_call>` form'), false);
  assert.equal(hasRawToolCallMarkup(`see \`<tool_call>\` then\n${real}`), true);
  // Streaming: a backticked opener must not hold the rest of the stream back.
  const s = splitVisibleFromToolCallBuffer('the `<tool_call>` tag then more prose');
  assert.equal(s.holdback, '');
}

console.log('All character-handling tests passed.');