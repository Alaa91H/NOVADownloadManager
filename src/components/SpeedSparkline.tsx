import React, { useId, useMemo } from 'react';

interface SpeedSparklineProps {
  /** Array of recent speed samples (bytes/sec). Oldest first. */
  samples: number[];
  /** Maximum number of samples to render. Older ones are trimmed. */
  maxSamples?: number;
  /** Width in CSS pixels. */
  width?: number;
  /** Height in CSS pixels. */
  height?: number;
  /** Color of the area fill (CSS var or hex). */
  color?: string;
  /** Color of the stroke line. */
  strokeColor?: string;
}

/**
 * A lightweight SVG sparkline that visualizes download speed over time.
 * Uses no external libraries — just raw SVG path generation.
 * Renders an area chart with a gradient fill and a smooth line on top.
 */
export const SpeedSparkline: React.FC<SpeedSparklineProps> = ({
  samples,
  maxSamples = 60,
  width = 200,
  height = 40,
  color = 'var(--accent-primary)',
  strokeColor = 'var(--accent-primary)',
}) => {
  const gradId = useId();
  const { areaPath, linePath } = useMemo(() => {
    const data = samples.slice(-maxSamples);
    if (data.length < 2) {
      return { areaPath: '', linePath: '' };
    }

    const max = Math.max(...data, 1);
    const stepX = width / (data.length - 1);

    let line = '';
    data.forEach((val, i) => {
      const x = (i * stepX).toFixed(1);
      const y = (height - (val / max) * height).toFixed(1);
      line += i === 0 ? `M${x},${y}` : ` L${x},${y}`;
    });

    // Area path: line + bottom edge
    const wStr = String(width);
    const hStr = String(height);
    const area = `${line} L${wStr},${hStr} L0,${hStr} Z`;

    return { areaPath: area, linePath: line };
  }, [samples, maxSamples, width, height]);

  if (!linePath) {
    return (
      <div
        style={{ width, height }}
        className="flex items-center justify-center text-[9px] text-[var(--text-muted)]"
      >
        —
      </div>
    );
  }

  return (
    <svg width={width} height={height} className="overflow-visible" role="img" aria-label="Speed graph">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={linePath} fill="none" stroke={strokeColor} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};
