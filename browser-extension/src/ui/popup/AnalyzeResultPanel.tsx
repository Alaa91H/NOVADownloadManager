import React, { useState } from 'react';
import { AnalyzeFormat, AnalyzeResponse } from '../../contracts/nova.protocol.v4';
import { formatFileSize } from '../../pipeline/quality-detector';
import { Download, Loader2, AlertCircle } from 'lucide-react';
import { runtimeRequest, messageFromError } from '../runtime-request';

function formatDuration(sec?: number): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function codecShort(codecs?: string): string {
  if (!codecs) return '';
  const c = codecs.toLowerCase();
  if (c.includes('av01')) return 'AV1';
  if (c.includes('hev') || c.includes('hvc')) return 'H.265';
  if (c.includes('avc')) return 'H.264';
  if (c.includes('vp9') || c.includes('vp09')) return 'VP9';
  if (c.includes('opus')) return 'Opus';
  if (c.includes('mp4a') || c.includes('aac')) return 'AAC';
  return codecs.split('.')[0]?.slice(0, 12) || codecs;
}

function qualityLabel(f: AnalyzeFormat): string {
  if (f.label) return f.label;
  if (f.height) return f.height >= 2160 ? '4K' : `${f.height}p`;
  if (f.bandwidth) return `${Math.round(f.bandwidth / 1000)}kbps`;
  return f.formatId || '?';
}

function sizeEstimate(f: AnalyzeFormat): string {
  if (f.estimatedSizeBytes && f.estimatedSizeBytes > 0) return formatFileSize(f.estimatedSizeBytes) ?? '—';
  return '—';
}

interface AnalyzeResultPanelProps {
  result: AnalyzeResponse;
  onDownload: (url: string, filename: string) => void;
  busy: boolean;
}

export function AnalyzeResultPanel({ result, onDownload, busy }: AnalyzeResultPanelProps) {
  const [selectedFormat, setSelectedFormat] = useState<string | null>(null);

  const videoFormats = result.formats.filter((f) => f.hasVideo);
  const audioFormats = result.formats.filter((f) => f.hasAudio && !f.hasVideo);
  const otherFormats = result.formats.filter((f) => !f.hasVideo && !f.hasAudio);

  function handleDownload(f: AnalyzeFormat): void {
    const title = (result.title || 'download').replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 100);
    const quality = f.height ? `${f.height}p` : f.label || f.formatId || 'direct';
    const ext = f.container || 'mp4';
    const filename = result.title
      ? `${title} [${quality}].${ext}`
      : `${quality}.${ext}`;
    onDownload(f.url, filename);
    setSelectedFormat(f.formatId || f.url);
  }

  function handleBestDownload(): {
    const best = videoFormats[0] ?? result.formats[0];
    if (best) handleDownload(best);
  }

  return (
    <div className="nova-analyze-panel">
      {/* Header */}
      <div className="nova-analyze-header">
        {result.thumbnail && (
          <img
            src={result.thumbnail}
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
          {result.title && (
            <div style={{ fontWeight: 600, fontSize: 12, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
              {result.title}
            </div>
          )}
          <div style={{ fontSize: 10, color: 'var(--nova-text-muted)', marginTop: 2 }}>
            {result.formats.length} format{result.formats.length !== 1 ? 's' : ''}
            {result.durationSec ? ` · ${formatDuration(result.durationSec)}` : ''}
            {result.isLive ? ' · Live' : ''}
          </div>
        </div>
      </div>

      {/* DRM warning */}
      {result.drmProtected && (
        <div className="nova-analyze-notice" data-kind="error">
          <AlertCircle style={{ width: 12, height: 12 }} />
          <span>This content is DRM-protected and cannot be downloaded.</span>
        </div>
      )}

      {/* Format table */}
      {!result.drmProtected && result.formats.length > 0 && (
        <div className="nova-analyze-scroll">
          <table className="nova-quality-table">
            <thead>
              <tr>
                <th>Quality</th>
                <th>Resolution</th>
                <th>Codec</th>
                <th>Size</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {result.formats.map((f, i) => {
                const isSent = selectedFormat === (f.formatId || f.url);
                return (
                  <tr
                    key={f.formatId || f.url || i}
                    className={isSent ? 'nova-analyze-row-sent' : undefined}
                  >
                    <td className="nova-q-name">
                      <span className="nova-quality-badge">
                        {f.hasVideo ? qualityLabel(f) : f.hasAudio ? `♫ ${codecShort(f.codecs)}` : qualityLabel(f)}
                      </span>
                    </td>
                    <td className="nova-q-dim">
                      {f.width && f.height ? `${f.width}×${f.height}` : ''}
                    </td>
                    <td>
                      <span className="nova-q-codec">{codecShort(f.codecs)}</span>
                    </td>
                    <td className="nova-q-size">{sizeEstimate(f)}</td>
                    <td className="nova-q-action">
                      <button
                        type="button"
                        className="nova-quality-download"
                        data-sent={isSent ? 'true' : undefined}
                        disabled={busy || isSent}
                        onClick={() => handleDownload(f)}
                      >
                        {isSent ? 'Done' : <><Download style={{ width: 10, height: 10 }} /> Download</>}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Best quality button */}
      {!result.drmProtected && result.formats.length > 0 && (
        <div className="nova-quality-footer" style={{ paddingTop: 8 }}>
          <button
            type="button"
            className="nova-quality-auto"
            disabled={busy}
            onClick={() => void handleBestDownload()}
          >
            Best Quality
          </button>
        </div>
      )}

      {/* No formats found */}
      {result.formats.length === 0 && !result.drmProtected && (
        <div className="nova-analyze-empty">
          <p>No downloadable formats found.</p>
          {result.message && <p className="nova-analyze-hint">{result.message}</p>}
        </div>
      )}
    </div>
  );
}

export default AnalyzeResultPanel;
