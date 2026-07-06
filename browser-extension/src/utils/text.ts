export function truncate(input: string, max = 120): string {
  return input.length <= max ? input : `${input.slice(0, max - 1)}…`;
}

export function byteLength(input: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(input).byteLength;
  return input.length;
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
