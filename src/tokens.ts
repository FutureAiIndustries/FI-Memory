/**
 * Token accounting (SPEC §5.7): `countTokens(text) = ceil(chars / 4)`.
 * A documented estimate on purpose — no tokenizer dependency, ever.
 */
export function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
