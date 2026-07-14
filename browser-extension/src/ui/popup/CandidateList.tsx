import React from 'react';
import { Candidate } from '../../contracts/candidate.schema';
import { redactString } from '../../security/redaction';
import { useI18n } from '../../i18n/react';
import type { TranslateFunction } from '../../i18n';
import { safeDisplayUrl } from '../../utils/url';
import { handoffPolicyDecision } from '../../security/handoff-policy';
import { explainCandidate, confidenceLevelOf } from '../../pipeline/evidence';
import { qualityBadge, formatBitrate, formatDuration, formatFileSize, codecDisplayName, formatContainer } from '../../pipeline/quality-detector';
import DetailGrid from '../components/DetailGrid';

function quality(candidate: Candidate, t: TranslateFunction): string {
  if (candidate.width && candidate.height) return `${candidate.width}×${candidate.height}`;
  const bestVariant = candidate.variants?.slice().sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  if (bestVariant?.width && bestVariant.height) return `${bestVariant.width}×${bestVariant.height}`;
  if (candidate.bitrate) return formatBitrate(candidate.bitrate) ?? `${Math.round(candidate.bitrate / 1000)} kbps`;
  return t('candidate.quality.unknown');
}

function confidenceLabel(confidence: number, t: TranslateFunction): { label: string; tone: 'success' | 'warning' | 'danger' | 'info' } {
  if (confidence >= 80) return { label: t('candidate.confidence.high'), tone: 'success' };
  if (confidence >= 50) return { label: t('candidate.confidence.medium'), tone: 'info' };
  if (confidence >= 20) return { label: t('candidate.confidence.low'), tone: 'warning' };
  return { label: t('candidate.confidence.hidden'), tone: 'danger' };
}

function title(candidate: Candidate): string {
  return candidate.filename ?? safeDisplayUrl(redactString(candidate.url)).replace(/^https?:\/\//, '');
}

function compactUrl(value?: string): string | undefined {
  return value ? safeDisplayUrl(redactString(value), 160) : undefined;
}

function evidence(candidate: Candidate): string {
  if (candidate.evidence && candidate.evidence.length > 0) {
    const sources = [...new Set(candidate.evidence.map((e) => e.source))];
    return sources.join(' · ');
  }
  const items = [candidate.source, candidate.headers?.contentType ? 'headers' : undefined, candidate.variants?.length ? 'variants' : undefined, candidate.subtitles?.length ? 'subtitles' : undefined].filter(Boolean);
  return items.join(' · ');
}

function evidenceSummary(candidate: Candidate): string[] {
  if (!candidate.evidence || candidate.evidence.length === 0) return [];
  return candidate.evidence.slice(0, 4).map((e) => {
    const sign = e.weight >= 0 ? '+' : '';
    return `[${e.source}] ${e.reason} (${sign}${e.weight})`;
  });
}

function mediaIcon(type: Candidate['mediaType']): string {
  switch (type) {
    case 'video': return '▶';
    case 'audio': return '♫';
    case 'image': return '◆';
    case 'document': return '📄';
    case 'archive': return '📦';
    case 'manifest': return '📺';
    case 'torrent':
    case 'magnet': return '🧲';
    case 'app': return '⚙';
    default: return '•';
  }
}

function QualityBadge({ candidate }: { candidate: Candidate }) {
  const badge = qualityBadge(candidate.width, candidate.height);
  if (!badge.label) return null;
  return (
    <span className="nova-quality-badge" style={{ '--badge-color': badge.color } as React.CSSProperties}>
      {badge.label}
    </span>
  );
}

function SizeDisplay({ candidate }: { candidate: Candidate }) {
  const text = candidate.sizeBytes ? formatFileSize(candidate.sizeBytes) : null;
  return <span className="nova-candidate-size">{text || '—'}</span>;
}

function DurationDisplay({ candidate }: { candidate: Candidate }) {
  const text = formatDuration(candidate.durationSec);
  if (!text) return null;
  return <span className="nova-candidate-duration">{text}</span>;
}

function CodecDisplay({ candidate }: { candidate: Candidate }) {
  const codecText = codecDisplayName(candidate.codecs);
  if (!codecText) return null;
  return <span className="nova-candidate-codec">{codecText}</span>;
}

function ContainerBadge({ candidate }: { candidate: Candidate }) {
  const container = formatContainer(candidate.extension);
  if (!container) return null;
  return <span className="nova-container-badge">{container}</span>;
}

export function CandidateList({ candidates, selected, onToggle, isCandidateSupported = () => true, unsupportedReason }: { candidates: Candidate[]; selected: Set<string>; onToggle(id: string): void; isCandidateSupported?: (candidate: Candidate) => boolean; unsupportedReason?: (candidate: Candidate) => string | undefined }) {
  const { t } = useI18n();
  if (candidates.length === 0) return <div className="nova-empty">
    <strong>{t('candidate.empty.title')}</strong>
    <p>{t('candidate.empty.help')}</p>
    <p className="nova-empty-hint">{t('candidate.empty.hint')}</p>
  </div>;
  return <div className="nova-list" aria-label={t('candidate.list.aria')}>
    {candidates.map((candidate) => {
      const handoff = handoffPolicyDecision(candidate);
      const runtimeSupported = isCandidateSupported(candidate);
      const blockedReason = !handoff.allowed ? handoff.reason : !runtimeSupported ? unsupportedReason?.(candidate) : undefined;
      const confidence = confidenceLabel(candidate.confidence, t);
      const variantsText = candidate.variants?.length ? t('candidate.variants', { n: candidate.variants.length }) : undefined;
      const subtitlesText = candidate.subtitles?.length ? t('candidate.subtitles', { n: candidate.subtitles.length }) : undefined;
      const candidateTitle = title(candidate);
      return <article key={candidate.id} className="nova-candidate" data-disabled={!handoff.allowed || !runtimeSupported}>
        <label className="nova-candidate-select">
          <input type="checkbox" disabled={!handoff.allowed || !runtimeSupported} checked={handoff.allowed && runtimeSupported && selected.has(candidate.id)} onChange={() => onToggle(candidate.id)} aria-label={t('candidate.select', { title: candidateTitle })} />
        </label>
        <div className="nova-candidate-icon" data-type={candidate.mediaType}>{mediaIcon(candidate.mediaType)}</div>
        <div className="nova-candidate-body">
          <div className="nova-candidate-heading">
            <strong className="nova-candidate-title" title={candidateTitle}>{candidateTitle}</strong>
          </div>
          <span className="nova-candidate-url" title={compactUrl(candidate.url)}>{compactUrl(candidate.url)}</span>
          <span className="nova-candidate-meta" aria-label={t('candidate.summary')}>
            <QualityBadge candidate={candidate} />
            <ContainerBadge candidate={candidate} />
            <CodecDisplay candidate={candidate} />
            <SizeDisplay candidate={candidate} />
            <DurationDisplay candidate={candidate} />
            <span className="nova-pill" data-tone={confidence.tone} data-confidence>{confidence.label}</span>
          </span>
          {variantsText || subtitlesText ? <span className="nova-candidate-meta">
            {variantsText ? <span className="nova-pill">{variantsText}</span> : null}
            {subtitlesText ? <span className="nova-pill">{subtitlesText}</span> : null}
          </span> : null}
          {runtimeSupported && (candidate.source === 'hls-manifest' || candidate.source === 'dash-manifest' || candidate.mediaType === 'manifest')
            ? <span className="nova-pill nova-pill-manifest">Manifest</span>
            : null}
          {blockedReason ? <div className="nova-inline-warning">{t('candidate.notHandoffable', { reason: blockedReason })}</div> : null}{/* Not directly handoffable */}
          <details className="nova-candidate-details">
            <summary>{t('candidate.details')}</summary>{/* Details and evidence */}
            {evidenceSummary(candidate).length > 0 ? <div className="nova-evidence-list" aria-label={t('candidate.evidence.aria')}>
              {evidenceSummary(candidate).map((line, i) => <div key={i} className="nova-evidence-item">{line}</div>)}
              {(candidate.evidence?.length ?? 0) > 4 ? <div className="nova-evidence-item nova-evidence-more">{t('candidate.evidence.more', { n: (candidate.evidence?.length ?? 0) - 4 })}</div> : null}
            </div> : null}
            <DetailGrid items={[
              { label: t('candidate.detail.source'), value: evidence(candidate) },
              { label: t('candidate.detail.confidence'), value: confidenceLevelOf(candidate.confidence) },
              { label: t('candidate.detail.filename'), value: candidate.filename },
              { label: t('candidate.detail.mime'), value: candidate.mimeType },
              { label: t('candidate.detail.codecs'), value: candidate.codecs?.join(', ') },
              { label: t('candidate.detail.size'), value: candidate.sizeBytes ? formatFileSize(candidate.sizeBytes) : undefined },
              { label: t('candidate.detail.bitrate'), value: candidate.bitrate ? formatBitrate(candidate.bitrate) : undefined },
              { label: t('candidate.detail.duration'), value: formatDuration(candidate.durationSec) },
              { label: t('candidate.detail.resolution'), value: candidate.width && candidate.height ? `${candidate.width}×${candidate.height}` : undefined },
              { label: t('candidate.detail.finalUrl'), value: compactUrl(candidate.finalUrl) },
              { label: t('candidate.detail.pageUrl'), value: compactUrl(candidate.pageUrl) },
              { label: t('candidate.detail.referrer'), value: compactUrl(candidate.referrer) },
              { label: t('candidate.detail.range'), value: candidate.headers?.acceptRanges },
              { label: t('candidate.detail.etag'), value: candidate.headers?.etag ? redactString(candidate.headers.etag) : undefined },
              { label: t('candidate.detail.lastModified'), value: candidate.headers?.lastModified },
            ]} />
            {candidate.variants?.length ? <div className="nova-detail-note">{t('candidate.bestVariant', { quality: quality(candidate, t), count: candidate.variants.length })}</div> : null}
            {candidate.subtitles?.length ? <div className="nova-detail-note">{t('candidate.subtitleTracks', { tracks: candidate.subtitles.map((track) => track.label ?? track.language ?? track.format ?? 'track').slice(0, 6).join(', ') })}</div> : null}
            <details className="nova-explain-details">
              <summary>{t('candidate.fullExplanation')}</summary>
              <pre className="nova-explain-pre">{explainCandidate(candidate).join('\n')}</pre>
            </details>
          </details>
        </div>
      </article>;
    })}
  </div>;
}
export default CandidateList;
