import type { MediaFormat } from '../../api/novaClient';

export type AdvancedTab = 'subtitles' | 'format' | 'network' | 'perf';

export function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${String(h)}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m)}:${String(s).padStart(2, '0')}`;
}

export function bestVideoFormat(formats: MediaFormat[], heightLimit?: number): MediaFormat | null {
  const candidates = formats.filter(
    (f) =>
      f.vcodec &&
      f.vcodec !== 'none' &&
      f.height != null &&
      f.height > 0 &&
      (heightLimit ? f.height <= heightLimit : true),
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const h = (b.height || 0) - (a.height || 0);
    if (h !== 0) return h;
    return (b.tbr || 0) - (a.tbr || 0);
  });
  return candidates[0];
}

export function resolutionLabel(height: number | null): string {
  if (!height) return 'Unknown';
  if (height >= 4320) return '8K';
  if (height >= 2880) return '2.8K';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '2K';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  if (height >= 360) return '360p';
  if (height >= 240) return '240p';
  return '144p';
}

export function resolutionBadgeColor(height: number | null): string {
  if (!height) return 'text-[var(--text-muted)] bg-[var(--bg-hover)] border-[var(--border-color)]';
  if (height >= 4320) return 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20';
  if (height >= 2160) return 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20';
  if (height >= 1440) return 'text-[var(--success)] bg-[var(--success-bg)] border-[var(--success-border)]';
  if (height >= 1080) return 'text-[var(--success)] bg-[var(--success-bg)] border-[var(--success-border)]';
  if (height >= 720) return 'text-[var(--info)] bg-[var(--info-bg)] border-[var(--info-border)]';
  return 'text-[var(--text-muted)] bg-[var(--bg-hover)] border-[var(--border-color)]';
}
