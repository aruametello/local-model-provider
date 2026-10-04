/**
 * Truncate a string to at most `maxCodePoints` Unicode code points without
 * splitting a surrogate pair. A plain UTF-16 `.slice(0, n)` can land between
 * the two halves of an astral character (emoji, CJK ext-B, etc.), producing a
 * lone surrogate that corrupts the outgoing request. Iterating with
 * `for...of` walks code points, so the result is always well-formed.
 *
 * Kept dependency-free (no vscode import) so tsconfig.test.json can compile
 * it standalone for the plain-Node unit tests.
 */
export function truncateToCodePoints(text: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) {
    return '';
  }
  let result = '';
  let count = 0;
  for (const codePoint of text) {
    if (count >= maxCodePoints) {
      break;
    }
    result += codePoint;
    count++;
  }
  return result;
}