interface Segment {
  id: number;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  active: boolean;
  speed: number;
}

interface SegmentVisualizationProps {
  segments: Segment[];
  className?: string;
}

export function SegmentVisualization({ segments, className = '' }: SegmentVisualizationProps) {
  if (!segments.length) return null;

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${String(bytes)} B`;
  };

  const formatSpeed = (bytes: number): string => {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
    return `${String(bytes)} B/s`;
  };

  const totalDownloaded = segments.reduce((acc, s) => acc + s.downloadedBytes, 0);
  const totalSize = segments.reduce((acc, s) => acc + s.totalBytes, 0);
  const totalProgress = totalSize > 0 ? totalDownloaded / totalSize : 0;

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">
          {String(segments.length)} segment{segments.length !== 1 ? 's' : ''}
        </span>
        <span className="text-[var(--text-muted)]">
          {(totalProgress * 100).toFixed(1)}% complete
        </span>
      </div>

      <div className="relative h-2 w-full overflow-hidden rounded-full bg-[var(--bg-hover)]">
        <div
          className="h-full rounded-full bg-[var(--accent-primary)] transition-all duration-300"
          style={{ width: `${String(totalProgress * 100)}%` }}
        />
      </div>

      <div className="flex flex-wrap gap-1">
        {segments.map((seg) => (
          <div
            key={seg.id}
            className={`group relative flex h-6 min-w-[40px] flex-col items-center justify-center rounded px-1 text-[10px] transition-colors ${
              seg.active
                ? seg.progress >= 1
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-blue-500/20 text-blue-400'
                : 'bg-[var(--bg-hover)] text-[var(--text-muted)]'
            }`}
            title={`Segment ${String(seg.id)}: ${formatBytes(seg.downloadedBytes)} / ${formatBytes(seg.totalBytes)} (${formatSpeed(seg.speed)})`}
          >
            <span className="font-mono">{String(seg.id)}</span>
            <div
              className="absolute bottom-0 left-0 h-0.5 bg-[var(--accent-primary)]/60 transition-all"
              style={{ width: `${String(seg.progress * 100)}%` }}
            />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-[var(--text-muted)]">
        {segments.map((seg) => (
          <div key={seg.id} className="flex items-center justify-between">
            <span className="font-mono">#{String(seg.id)}</span>
            <span>{(seg.progress * 100).toFixed(1)}%</span>
            <span>{formatSpeed(seg.speed)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
