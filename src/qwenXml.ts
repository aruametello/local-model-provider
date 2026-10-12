export interface QwenXmlToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ParsedQwenXmlToolCalls {
  text: string;
  toolCalls: QwenXmlToolCall[];
}

/**
 * Parse Qwen XML-style tool calls that may stream as content or reasoning
 * instead of OpenAI-compatible tool_calls.
 *
 * Implemented as a small tag-aware scanner instead of lazy regexes: a lazy
 * `[\s\S]*?<\/parameter>` match stops at the FIRST closing tag, so a parameter
 * value that legitimately contains the literal text `</parameter>` (code
 * snippets, strings, etc.) was silently truncated and the remainder of the
 * tool call was misparsed. The scanner below matches the LAST closing tag
 * before the next `<parameter=` / `</function>` boundary, so embedded closing
 * tags inside values are preserved.
 */
export function parseQwenXmlToolCalls(text: string): ParsedQwenXmlToolCalls {
  const toolCalls: QwenXmlToolCall[] = [];

  // Pair every `</function>` with the NEAREST preceding unpaired `<function=`.
  // A lazy "first open … first close" regex mis-pairs when the model's prose
  // (typically its reasoning) MENTIONS `<function=name>` before the real call:
  // the prose open swallowed the real call's `</function>`, producing a bogus
  // call named "name" and eating both the prose and the real call. With
  // nearest-open pairing a prose mention stays an unpaired open and is ignored.
  const FUNC_OPEN = /<function=([^>\s]+)>/g;
  const FUNC_CLOSE = '</function>';
  const events: Array<{ idx: number; kind: 'open' | 'close'; name?: string; end: number }> = [];
  for (let m = FUNC_OPEN.exec(text); m; m = FUNC_OPEN.exec(text)) {
    events.push({ idx: m.index, kind: 'open', name: m[1], end: m.index + m[0].length });
  }
  for (let i = text.indexOf(FUNC_CLOSE); i !== -1; i = text.indexOf(FUNC_CLOSE, i + FUNC_CLOSE.length)) {
    events.push({ idx: i, kind: 'close', end: i + FUNC_CLOSE.length });
  }
  events.sort((x, y) => x.idx - y.idx);

  const spans: Array<{ start: number; end: number }> = [];
  const stack: Array<{ idx: number; name: string; end: number }> = [];
  for (const ev of events) {
    if (ev.kind === 'open') {
      stack.push({ idx: ev.idx, name: ev.name as string, end: ev.end });
      continue;
    }
    const open = stack.pop();
    if (!open) {
      continue;
    }

    // Optional <tool_call> wrapper directly before the open / </tool_call> after the close.
    let start = open.idx;
    const before = text.slice(0, open.idx).replace(/\s+$/, '');
    if (before.endsWith('<tool_call>')) {
      start = before.length - '<tool_call>'.length;
    }
    let end = ev.end;
    const after = /^\s*<\/tool_call>/.exec(text.slice(end));
    if (after) {
      end += after[0].length;
    }

    // A block quoted in inline code (`<function=x>…</function>`) is a mention, not a call.
    if (text[start - 1] === '`' && text[end] === '`') {
      continue;
    }

    const args: Record<string, unknown> = {};
    for (const { key, value: rawValue } of extractParameters(text.slice(open.end, ev.idx).trim())) {
      args[key] = coerceParameterValue(rawValue);
    }
    toolCalls.push({
      id: `qwen_xml_${Date.now()}_${toolCalls.length}`,
      name: open.name.trim(),
      arguments: JSON.stringify(args),
    });
    spans.push({ start, end });
  }

  // Blocks are produced in close order == document order (nearest pairing never nests).
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    cursor = span.end;
  }
  out += text.slice(cursor);

  return { text: out.trim(), toolCalls };
}

/**
 * Split an accumulated streamed text buffer into the portion that is safe to
 * display now and the portion that must be held back until more of the stream
 * arrives (or end-of-stream resolution).
 *
 * Qwen models can emit an entire tool call as plain text
 * (`<tool_call>…</tool_call>`) instead of structured tool_calls. A hold-back bounded by a fixed
 * number of trailing tokens is wrong in both directions: the block body can be
 * arbitrarily long (whole code snippets), and flushing "everything before the
 * last n characters" would leak raw XML mid-stream. The correct boundary is
 * the tag pair itself: everything up to and including the LAST CLOSED
 * `<tool_call>…</tool_call>` block is safe to show (the caller converts it via
 * `parseQwenXmlToolCalls`), while anything from an open `<tool_call` whose
 * `</tool_call>` has not arrived yet stays held back until the closing tag completes it
 * or end-of-stream resolves the remainder.
 *
 * A trailing fragment that is a strict prefix of `<tool_call` (the tag split
 * across two SSE chunks, e.g. `"<tool_c"` then `"all>..."`) is also held back,
 * so an incomplete open tag can never be half-flushed and misread as text.
 */
export function splitVisibleFromToolCallBuffer(buffer: string): { visible: string; holdback: string } {
  // Each opening marker with the marker that terminates its block. A bare
  // `<function=` block (no `<tool_call>` wrapper) closes at `</function>`.
  const PAIRS = [
    { open: '<tool_call', close: '</tool_call>' },
    { open: '<function=', close: '</function>' },
  ];

  let safeEnd = 0;
  let cursor = 0;
  for (;;) {
    let first: { open: string; close: string; idx: number } | undefined;
    for (const pair of PAIRS) {
      let idx = buffer.indexOf(pair.open, cursor);
      // An opener right after a backtick is a prose mention (`<tool_call>`), not
      // a call: do not hold the rest of the stream back for it.
      while (idx > 0 && buffer[idx - 1] === '`') {
        idx = buffer.indexOf(pair.open, idx + pair.open.length);
      }
      if (idx !== -1 && (!first || idx < first.idx)) {
        first = { ...pair, idx };
      }
    }
    if (!first) {
      break;
    }
    const closeIdx = buffer.indexOf(first.close, first.idx + first.open.length);
    if (closeIdx === -1) {
      // Open marker without its closing marker yet: hold back from the open marker.
      return { visible: buffer.slice(0, first.idx), holdback: buffer.slice(first.idx) };
    }
    safeEnd = closeIdx + first.close.length;
    cursor = safeEnd;
  }

  if (safeEnd === buffer.length) {
    return { visible: buffer, holdback: '' };
  }

  // Text after the last closed block may end with a partial opening marker
  // split across a chunk boundary: hold back only that suffix.
  let holdLen = 0;
  for (const pair of PAIRS) {
    const maxHold = Math.min(buffer.length - safeEnd, pair.open.length - 1);
    for (let len = maxHold; len > holdLen; len--) {
      if (buffer.endsWith(pair.open.slice(0, len))) {
        holdLen = len;
        break;
      }
    }
  }

  return { visible: buffer.slice(0, buffer.length - holdLen), holdback: buffer.slice(buffer.length - holdLen) };
}

/** True when the text contains a `<tool_call` / `<function=` opening marker. */
export function containsToolCallOpenMarker(text: string): boolean {
  return /<tool_call(?![A-Za-z0-9_])|<function=[^>\s]+>/.test(text);
}

/**
 * Detect a malformed tool call written as plain text: a raw tool-call block
 * that is NOT backed by a structured tool call. Deliberately stricter than
 * "contains the tag name" so prose that merely mentions `<tool_call>` does not
 * trigger a corrective retry, but covers every shape seen in practice:
 *  - a full `<tool_call>…</tool_call>` pair (any body: XML or JSON),
 *  - an UNTERMINATED block (`<tool_call>` followed by `<function=` or `{`),
 *    typical when generation stops (stop sequence / length) before the close tag,
 *  - a bare `<function=name>…</function>` / `<parameter=` block with no wrapper.
 */
export function hasRawToolCallMarkup(rawText: string): boolean {
  if (!rawText) {
    return false;
  }
  // Markers quoted in inline code are prose, not calls.
  const text = rawText.replace(/`[^`\n]*`/g, '``');
  if (/<tool_call(?![A-Za-z0-9_])[^>]*>[\s\S]*<\/tool_call>/.test(text)) {
    return true;
  }
  if (/<tool_call(?![A-Za-z0-9_])[^>]*>\s*(?:<function=|\{)/.test(text)) {
    return true;
  }
  return /<function=[^>\s]+>[\s\S]*(?:<parameter=|<\/function>)/.test(text);
}

/**
 * Extract `<parameter=key>value</parameter>` pairs from a tool-call body.
 *
 * Scans left to right for `<parameter=` open tags and matches each one to the
 * LAST `</parameter>` before the next `<parameter=` open tag (or the end of
 * the body). This keeps literal `</parameter>` text inside a value intact
 * instead of truncating at the first occurrence.
 */
export function extractParameters(body: string): Array<{ key: string; value: string }> {
  const parameters: Array<{ key: string; value: string }> = [];
  const openPattern = /<parameter=([^>\s]+)>/g;
  let openMatch: RegExpExecArray | null;

  while ((openMatch = openPattern.exec(body)) !== null) {
    const key = openMatch[1].trim();
    const valueStart = openPattern.lastIndex;

    // Find the LAST closing tag before the next `<parameter=` open tag.
    const nextOpen = body.indexOf('<parameter=', valueStart);
    const searchEnd = nextOpen === -1 ? body.length : nextOpen;
    const closeTag = '</parameter>';
    let closeIndex = body.lastIndexOf(closeTag, searchEnd - 1);
    if (closeIndex === -1) {
      // No closing tag before the next open tag (or end): treat the rest of
      // the body as the value (unterminated parameter).
      closeIndex = body.length;
    }

    const rawValue = body.slice(valueStart, closeIndex).trim();
    parameters.push({ key, value: rawValue });

    // Resume scanning after the closing tag so a value that contains the
    // literal text `</parameter>` is not re-scanned as a boundary.
    openPattern.lastIndex = Math.min(closeIndex + closeTag.length, body.length);
  }

  return parameters;
}

/**
 * Coerce a raw XML parameter value to a JSON-friendly value, mirroring the
 * original coercion rules (int, float, boolean, JSON object/array, else string).
 */
export function coerceParameterValue(rawValue: string): unknown {
  let value: unknown = rawValue;

  if (/^-?\d+$/.test(rawValue)) {
    value = Number.parseInt(rawValue, 10);
  } else if (/^-?\d+\.\d+$/.test(rawValue)) {
    value = Number.parseFloat(rawValue);
  } else if (rawValue === 'true' || rawValue === 'false') {
    value = rawValue === 'true';
  } else if ((rawValue.startsWith('{') && rawValue.endsWith('}')) || (rawValue.startsWith('[') && rawValue.endsWith(']'))) {
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }
  }

  return value;
}
