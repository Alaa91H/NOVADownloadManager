import React, { useState } from 'react';
import { qualityBadge, formatBitrate, formatFileSize } from '../../pipeline/quality-detector';

export interface StreamQualityItem {
  id: string;
  url: string;
  quality?: string;
  label?: string;
  width?: number;
  height?: number;
  bandwidth?: number;
  codecs?: string;
  container?: string;
  fps?: number;
  hdr?: boolean;
  sizeBytes?: number;
  type: 'video' | 'audio';
  formatId?: string;
  hasAudio?: boolean;
  hasVideo?: boolean;
  videoTitle?: string;
}

interface QualityTableProps {
  qualities: StreamQualityItem[];
  title?: string;
  videoTitle?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  onSendQuality: (quality: StreamQualityItem) => void;
  onSendBest: () => void;
  busy?: boolean;
  sentIds?: Set<string>;
}

function formatDuration(sec?: number): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function resolutionText(w?: number, h?: number): string {
  if (!w || !h) return '';
  return `${w}×${h}`;
}

function codecShort(codecs?: string): string {
  if (!codecs) return '';
  const c = codecs.toLowerCase();
  if (c.includes('av01')) return 'AV1';
  if (c.includes('hev') || c.includes('hvc')) return 'H.265';
  if (c.includes('avc')) return 'H.264';
  if (c.includes('vp9') || c.includes('vp09')) return 'VP9';
  if (c.includes('vp8')) return 'VP8';
  if (c.includes('opus')) return 'Opus';
  if (c.includes('mp4a') || c.includes('aac')) return 'AAC';
  if (c.includes('vorbis')) return 'Vorbis';
  return codecs.split('.')[0]?.slice(0, 12) || codecs;
}

function containerLabel(container?: string, type?: string): string {
  if (container) return container.toUpperCase();
  return type === 'audio' ? 'AUDIO' : '';
}

function sizeEstimate(item: StreamQualityItem, durationSec?: number): string {
  if (item.sizeBytes && item.sizeBytes > 0) return formatFileSize(item.sizeBytes) ?? '—';
  if (item.bandwidth && durationSec) {
    const estimated = (item.bandwidth * durationSec) / 8;
    return `~${formatFileSize(Math.round(estimated))}`;
  }
  return '—';
}

function qualityLabel(item: StreamQualityItem): string {
  if (item.label) return item.label;
  if (item.hdr && item.quality) return `${item.quality} HDR`;
  if (item.fps && item.fps >= 50 && item.quality) return `${item.quality}${item.fps}`;
  if (item.quality) return item.quality;
  const badge = qualityBadge(item.width, item.height);
  if (badge.label) return badge.label;
  if (item.bandwidth) return formatBitrate(item.bandwidth) ?? '';
  return '?';
}

export function QualityTable({
  qualities,
  title,
  videoTitle,
  thumbnailUrl,
  durationSec,
  onSendQuality,
  onSendBest,
  busy = false,
  sentIds,
}: QualityTableProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const allSorted = [...qualities].sort((a, b) => {
    const aH = a.type === 'audio' ? -(a.bandwidth ?? 0) : (a.height ?? 0);
    const bH = b.type === 'audio' ? -(b.bandwidth ?? 0) : (b.height ?? 0);
    return bH - aH;
  });

  const hasDuration = durationSec && durationSec > 0;

  function renderTableHeader() {
    return (
      <thead>
        <tr>
          <th>Quality</th>
          <th>Resolution</th>
          <th>Codec</th>
          <th>FPS</th>
          <th>Container</th>
          <th>Size</th>
          <th></th>
        </tr>
      </thead>
    );
  }

  function renderRow(item: StreamQualityItem) {
    const isSent = sentIds?.has(item.id) || sentIds?.has(item.url);
    const isHovered = hoveredId === item.id;
    const badge = qualityBadge(item.width, item.height);
    const isAudio = item.type === 'audio';
    const itemWithTitle = { ...item, videoTitle: item.videoTitle || videoTitle };

    return (
      <tr
        key={item.id}
        onMouseEnter={() => setHoveredId(item.id)}
        onMouseLeave={() => setHoveredId(null)}
        style={isHovered ? { background: 'rgba(59, 130, 246, 0.08)' } : undefined}
      >
        <td className="nova-q-name">
          <span
            className="nova-quality-badge"
            style={{ '--badge-color': isAudio ? '#a855f7' : badge.color } as React.CSSProperties}
          >
            {isAudio ? (
              <span style={{ color: '#c084fc', marginRight: 2, fontSize: 8 }}>♫ </span>
            ) : item.hdr ? (
              <span style={{ color: '#f59e0b', marginRight: 3, fontSize: 8 }}>HDR</span>
            ) : null}
            {qualityLabel(item)}
          </span>
        </td>
        <td className="nova-q-dim">{resolutionText(item.width, item.height)}</td>
        <td>
          <span className="nova-q-codec">{codecShort(item.codecs)}</span>
        </td>
        <td className="nova-q-dim">
          {item.fps && item.fps >= 50 ? (
            <span style={{ color: '#22c55e', fontWeight: 600 }}>{item.fps}fps</span>
          ) : (
            item.fps ? `${item.fps}fps` : ''
          )}
        </td>
        <td className="nova-q-dim">{containerLabel(item.container, item.type)}</td>
        <td className="nova-q-size">{sizeEstimate(item, durationSec)}</td>
        <td className="nova-q-action">
          <button
            type="button"
            className={isSent ? 'nova-quality-download' : 'nova-quality-download'}
            data-sent={isSent ? 'true' : undefined}
            disabled={busy || isSent}
            onClick={() => onSendQuality(itemWithTitle)}
          >
            {isSent ? 'Done' : 'Download'}
          </button>
        </td>
      </tr>
    );
  }

  return (
    <div className="nova-quality-selector">
      {/* Header with video info */}
      {(videoTitle || thumbnailUrl) && (
        <div style={{ display: 'flex', gap: 8, padding: '4px 0 8px', alignItems: 'flex-start' }}>
          {thumbnailUrl && (
            <img
              src={thumbnailUrl}
              alt=""
              style={{
                width: 80,
                height: 45,
                borderRadius: 6,
                objectFit: 'cover',
                flexShrink: 0,
              }}
            />
          )}
          <div style={{ minWidth: 0 }}>
            {videoTitle && (
              <div style={{ fontWeight: 600, fontSize: 12, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                {videoTitle}
              </div>
            )}
            {hasDuration && (
              <div style={{ fontSize: 10, color: 'var(--nova-text-muted)', marginTop: 2 }}>
                Duration: {formatDuration(durationSec)}
              </div>
            )}
            <div style={{ fontSize: 10, color: 'var(--nova-text-muted)', marginTop: 1 }}>
              {qualities.length} format{qualities.length !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
      )}

      {title && (
        <div className="nova-quality-header">
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--nova-text)' }}>{title}</span>
        </div>
      )}

      {/* Unified qualities table */}
      {allSorted.length > 0 && (
        <table className="nova-quality-table">
          {renderTableHeader()}
          <tbody>
            {allSorted.map(renderRow)}
          </tbody>
        </table>
      )}

      {/* Footer with Best Quality button */}
      <div className="nova-quality-footer" style={{ paddingTop: 8 }}>
        <button
          type="button"
          className="nova-quality-auto"
          disabled={busy || qualities.length === 0}
          onClick={onSendBest}
        >
          Best Quality
        </button>
      </div>

      {!hasDuration && qualities.length > 0 && (
        <div className="nova-quality-hint">
          Sizes are estimated from bitrate — actual size may vary
        </div>
      )}
    </div>
  );
}

export default QualityTable;
