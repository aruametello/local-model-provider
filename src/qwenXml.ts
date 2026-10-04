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
  const withoutToolCalls = text.replace(
    /<tool_call>\s*<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>\s*<\/tool_call>/g,
    (_match, name, body) => {
      const args: Record<string, unknown> = {};
      const parameters = extractParameters(body);

      for (const { key, value: rawValue } of parameters) {
        args[key] = coerceParameterValue(rawValue);
      }

      toolCalls.push({
        id: `qwen_xml_${Date.now()}_${toolCalls.length}`,
        name: String(name).trim(),
        arguments: JSON.stringify(args),
      });
      return '';
    }
  );

  return { text: withoutToolCalls.trim(), toolCalls };
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
