/**
 * Professional quality detection — maps resolution, bitrate, and codec
 * to human-readable labels suitable for the popup quality selector.
 */

type QualityTier = {
  label: string;
  shortLabel: string;
  minHeight: number;
  color: string;
};

const QUALITY_TIERS: QualityTier[] = [
  { label: '4320p (8K)', shortLabel: '8K', minHeight: 4320, color: '#a855f7' },
  { label: '2160p (4K)', shortLabel: '4K', minHeight: 2160, color: '#a855f7' },
  { label: '1440p (QHD)', shortLabel: '1440p', minHeight: 1440, color: '#3b82f6' },
  { label: '1080p (Full HD)', shortLabel: '1080p', minHeight: 1080, color: '#22c55e' },
  { label: '720p (HD)', shortLabel: '720p', minHeight: 720, color: '#22c55e' },
  { label: '480p (SD)', shortLabel: '480p', minHeight: 480, color: '#f59e0b' },
  { label: '360p', shortLabel: '360p', minHeight: 360, color: '#f59e0b' },
  { label: '240p', shortLabel: '240p', minHeight: 240, color: '#ef4444' },
  { label: '144p', shortLabel: '144p', minHeight: 144, color: '#ef4444' },
  { label: 'Audio Only', shortLabel: 'Audio', minHeight: 0, color: '#a1a1aa' },
];

function tierForHeight(height?: number): QualityTier {
  if (!height) return QUALITY_TIERS[QUALITY_TIERS.length - 1]!;
  for (const tier of QUALITY_TIERS) {
    if (height >= tier.minHeight) return tier;
  }
  return QUALITY_TIERS[QUALITY_TIERS.length - 1]!;
}

export function qualityBadge(width?: number, height?: number): { label: string; color: string } {
  const tier = tierForHeight(height);
  return { label: tier.shortLabel, color: tier.color };
}

export function formatBitrate(bps?: number): string | undefined {
  if (!bps || !Number.isFinite(bps)) return undefined;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} kbps`;
  return `${bps} bps`;
}

export function formatDuration(seconds?: number): string | undefined {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

export function formatFileSize(bytes?: number): string | undefined {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function codecDisplayName(codecs?: string[]): string | undefined {
  if (!codecs || codecs.length === 0) return undefined;
  const names: string[] = [];
  for (const codec of codecs) {
    const lower = codec.toLowerCase();
    if (lower.includes('avc1') || lower.includes('h264')) { names.push('H.264'); continue; }
    if (lower.includes('hev1') || lower.includes('hvc1') || lower.includes('h265')) { names.push('H.265'); continue; }
    if (lower.includes('vp09') || lower.includes('vp9')) { names.push('VP9'); continue; }
    if (lower.includes('av01') || lower.includes('av1')) { names.push('AV1'); continue; }
    if (lower.includes('vp8')) { names.push('VP8'); continue; }
    if (lower.includes('theora')) { names.push('Theora'); continue; }
    if (lower.includes('mp4a') || lower.includes('aac')) { names.push('AAC'); continue; }
    if (lower.includes('opus')) { names.push('Opus'); continue; }
    if (lower.includes('vorbis')) { names.push('Vorbis'); continue; }
    if (lower.includes('flac')) { names.push('FLAC'); continue; }
    if (lower.includes('mp3') || lower.includes('mp3')) { names.push('MP3'); continue; }
    names.push(codec);
  }
  return names.length > 0 ? names.join(' / ') : undefined;
}

export function formatContainer(extension?: string): string | undefined {
  if (!extension) return undefined;
  const map: Record<string, string> = {
    mp4: 'MP4', m4v: 'M4V', webm: 'WebM', mkv: 'MKV', mov: 'MOV',
    avi: 'AVI', flv: 'FLV', wmv: 'WMV', '3gp': '3GP', ogv: 'OGV',
    mpeg: 'MPEG', mpg: 'MPG', m2ts: 'M2TS', ts: 'TS',
    mp3: 'MP3', m4a: 'M4A', aac: 'AAC', flac: 'FLAC', wav: 'WAV',
    ogg: 'OGG', opus: 'Opus', wma: 'WMA',
    m3u8: 'HLS', mpd: 'DASH',
  };
  return map[extension.toLowerCase()] ?? extension.toUpperCase();
}
