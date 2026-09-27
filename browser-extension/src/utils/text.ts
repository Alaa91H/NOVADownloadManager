export function byteLength(input: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(input).byteLength;
  return input.length;
}
