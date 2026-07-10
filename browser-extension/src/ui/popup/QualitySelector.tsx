import React, { useCallback, useMemo, useState } from 'react';
import { Candidate } from '../../contracts/candidate.schema';
import { runtimeRequest, messageFromError } from '../runtime-request';
import { formatBytes } from '../../utils/text';
import { useI18n } from '../../i18n/react';

type Quality = {
  url: string;
  width?: number;
  height?: number;
  bandwidth?: number;
  codecs?: string;
  label?: string;
  estimatedSizeBytes?: number;
  container?: string;
  fps?: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
  formatId?: string;
};

type ResolveResponse = {
  ok: boolean;
  qualities?: Quality[];
  durationSec?: number;
  isLive?: boolean;
  estimatedSizeBytes?: number;
  message?: string;
};

function resolutionLabel(q: Quality): string {
  if (q.label) return q.label;
  if (q.height) return `${q.height}p`;
  if (q.bandwidth) return `${Math.round(q.bandwidth / 1000)}k`;
  return 'auto';
}

function dimensionsText(q: Quality): string | undefined {
  if (q.width && q.height) return `${q.width}×${q.height}`;
  return undefined;
}

function codecShort(codecs?: string): string | undefined {
  if (!codecs) return undefined;
  const c = codecs.toLowerCase();
  if (c.includes('av01')) return 'AV1';
  if (c.includes('hev') || c.includes('hvc')) return 'H.265';
  if (c.includes('avc')) return 'H.264';
  if (c.includes('vp9') || c.includes('vp09')) return 'VP9';
  if (c.includes('vp8')) return 'VP8';
  return codecs.split('.')[0];
}

// Estimate size from bitrate × duration when NOVA doesn't report a per-quality size.
function sizeText(q: Quality, durationSec?: number): string {
  if (q.estimatedSizeBytes) return formatBytes(q.estimatedSizeBytes);
  if (q.bandwidth && durationSec) return `~${formatBytes((q.bandwidth / 8) * durationSec)}`;
  return '—';
}

function containerText(q: Quality): string {
  if (q.container) return q.container.toUpperCase();
  if (q.url.includes('.m3u8') || q.url.includes('.ts')) return 'HLS';
  if (q.url.includes('.mpd')) return 'DASH';
  if (q.url.includes('.webm')) return 'WEBM';
  if (q.url.includes('.mp4')) return 'MP4';
  return '—';
}

/**
 * QualitySelector — IDM-style quality table for HLS/DASH manifests.
 *
 * Resolves the manifest via NOVA (RESOLVE_STREAM) and renders one row per
 * quality with resolution, dimensions, size, container, codec, and a Download
 * button (SEND_STREAM). Qualities are sorted highest-first. NOVA owns the actual
 * download; the extension only surfaces the choices.
 */
export function QualitySelector({ candidate, onSent }: { candidate: Candidate; onSent?: () => void }) {
  const { t } = useI18n();
  const isManifest = candidate.source === 'hls-manifest' || candidate.source === 'dash-manifest' || candidate.mediaType === 'manifest';
  const manifestType: 'hls' | 'dash' = candidate.source === 'dash-manifest' ? 'dash' : 'hls';

  const [resolved, setResolved] = useState<Quality[] | undefined>(undefined);
  const [meta, setMeta] = useState<{ durationSec?: number; isLive?: boolean }>();
  const [status, setStatus] = useState<'idle' | 'resolving' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const [sendingUrl, setSendingUrl] = useState<string>();
  const [sentUrl, setSentUrl] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const localQualities: Quality[] = (candidate.variants ?? []).map((v) => ({ url: v.url, width: v.width, height: v.height, bandwidth: v.bandwidth, codecs: v.codecs, label: v.label }));

  const resolve = useCallback(async () => {
    setStatus('resolving');
    setError(undefined);
    try {
      const response = await runtimeRequest<ResolveResponse>({
        type: 'RESOLVE_STREAM',
        manifestType,
        url: candidate.finalUrl ?? candidate.url,
        pageUrl: candidate.pageUrl,
      });
      setResolved(response.qualities ?? []);
      setMeta({ durationSec: response.durationSec, isLive: response.isLive });
      setStatus('done');
    } catch (err) {
      setError(messageFromError(err));
      setStatus('error');
    }
  }, [candidate, manifestType]);

  const send = useCallback(async (quality?: Quality) => {
    const qualityUrl = quality?.url;
    setSendingUrl(qualityUrl ?? 'auto');
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await runtimeRequest<{ ok?: boolean; accepted?: boolean; duplicate?: boolean; taskId?: string; message?: string }>(
        { type: 'SEND_STREAM', candidateId: candidate.id, selectedQualityUrl: qualityUrl, selectedQuality: quality },
      );
      const label = qualityUrl ? t('quality.selectedQuality') : t('quality.bestQualityChoice');
      if (result?.duplicate) {
        setNotice(t('quality.alreadyQueued', { label }));
      } else if (result?.ok === false || result?.accepted === false) {
        setError(result?.message ?? t('quality.novaNotAccepted'));
        return;
      } else {
        setNotice(t('quality.sentToNOVA', { label }));
      }
      setSentUrl(qualityUrl ?? 'auto');
      onSent?.();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSendingUrl(undefined);
    }
  }, [candidate.id, onSent]);

  // Sort highest-resolution / highest-bitrate first (IDM lists best quality on top).
  const qualities = useMemo(() => {
    const list = resolved ?? localQualities;
    return [...list].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
  }, [resolved, localQualities]);

  if (!isManifest) return null;

  return (
    <div className="nova-quality-selector" aria-label={t('quality.aria')}>
      <div className="nova-quality-header">
        <strong>{t('quality.header', { n: qualities.length })}</strong>
        <button type="button" className="nova-quality-resolve" disabled={status === 'resolving'} onClick={() => void resolve()}>
          {status === 'resolving' ? t('quality.resolving') : resolved ? t('quality.reresolveViaNOVA') : t('quality.resolveViaNOVA')}
        </button>
      </div>

      {meta?.isLive ? <div className="nova-detail-note">{t('quality.liveStream')}</div> : null}

      {qualities.length === 0 ? (
        <div className="nova-detail-note">
          {status === 'done'
            ? t('quality.noneFromNOVA')
            : t('quality.noneLocal')}
        </div>
      ) : (
        <table className="nova-quality-table">
          <thead>
            <tr>
              <th scope="col">{t('quality.column.quality')}</th>
              <th scope="col">{t('quality.column.resolution')}</th>
              <th scope="col">{t('quality.column.size')}</th>
              <th scope="col">{t('quality.column.format')}</th>
              <th scope="col" aria-label={t('quality.column.download')} />
            </tr>
          </thead>
          <tbody>
            {qualities.map((q) => (
              <tr key={q.url}>
                <td className="nova-q-name">
                  {resolutionLabel(q)}
                  {q.fps ? <span className="nova-q-sub">{Math.round(q.fps)}fps</span> : null}
                </td>
                <td className="nova-q-dim">{dimensionsText(q) ?? '\u2014'}</td>
                <td className="nova-q-size">{sizeText(q, meta?.durationSec)}</td>
                <td className="nova-q-fmt">
                  <span className="nova-pill">{containerText(q)}</span>
                  {codecShort(q.codecs) ? <span className="nova-q-codec">{codecShort(q.codecs)}</span> : null}
                </td>
                <td className="nova-q-action">
                  <button
                    type="button"
                    className="nova-quality-download"
                    data-sent={sentUrl === q.url ? 'true' : undefined}
                    disabled={Boolean(sendingUrl)}
                    onClick={() => void send(q)}
                    aria-label={t('quality.downloadAria', { quality: resolutionLabel(q) })}
                  >
                    {sendingUrl === q.url ? t('quality.sending') : sentUrl === q.url ? t('quality.sent') : t('quality.download')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="nova-quality-footer">
        <button type="button" className="nova-quality-auto" data-sent={sentUrl === 'auto' ? 'true' : undefined} disabled={Boolean(sendingUrl)} onClick={() => void send(undefined)}>
          {sendingUrl === 'auto' ? t('quality.sending') : sentUrl === 'auto' ? t('quality.sentBestQuality') : t('quality.bestQuality')}
        </button>
      </div>

      {notice ? <div className="nova-notice" data-kind="success" role="status">{notice}</div> : null}
      {error ? <div className="nova-notice" data-kind="error" role="status">{error}</div> : null}
      {!resolved && status === 'idle' && localQualities.length > 0 ? (
        <div className="nova-quality-hint">{t('quality.localHint')}</div>
      ) : null}
    </div>
  );
}

export default QualitySelector;
