import React from 'react';
import { Candidate } from '../../contracts/candidate.schema';
import { formatBytes } from '../../utils/text';
import { redactString } from '../../security/redaction';
import { useI18n } from '../../i18n/react';
import type { TranslateFunction } from '../../i18n';
import { safeDisplayUrl } from '../../utils/url';
import { handoffPolicyDecision } from '../../security/handoff-policy';
import { explainCandidate, confidenceLevelOf } from '../../pipeline/evidence';
import DetailGrid from '../components/DetailGrid';
import QualitySelector from './QualitySelector';

function quality(candidate: Candidate, t: TranslateFunction): string {
  if (candidate.width && candidate.height) return `${candidate.width}×${candidate.height}`;
  const bestVariant = candidate.variants?.slice().sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  if (bestVariant?.width && bestVariant.height) return `${bestVariant.width}×${bestVariant.height}`;
  if (candidate.bitrate) return `${Math.round(candidate.bitrate / 1000)} kbps`;
  return t('candidate.quality.unknown');
}

function duration(value?: number): string | undefined {
  if (!value || !Number.isFinite(value)) return undefined;
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
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

export function CandidateList({ candidates, selected, onToggle, onStreamSent, showHandoffWarnings = true }: { candidates: Candidate[]; selected: Set<string>; onToggle(id: string): void; onStreamSent?: () => void; showHandoffWarnings?: boolean }) {
  const { t } = useI18n();
  if (candidates.length === 0) return <div className="adm-empty">
    <strong>{t('candidate.empty.title')}</strong>
    <p>{t('candidate.empty.help')}</p>
    <p className="adm-empty-hint">{t('candidate.empty.hint')}</p>
  </div>;
  return <div className="adm-list" aria-label={t('candidate.list.aria')}>
    {candidates.map((candidate) => {
      const handoff = handoffPolicyDecision(candidate);
      const confidence = confidenceLabel(candidate.confidence, t);
      const variantsText = candidate.variants?.length ? t('candidate.variants', { n: candidate.variants.length }) : undefined;
      const subtitlesText = candidate.subtitles?.length ? t('candidate.subtitles', { n: candidate.subtitles.length }) : undefined;
      const candidateTitle = title(candidate);
      return <article key={candidate.id} className="adm-candidate" data-disabled={!handoff.allowed}>
        <label className="adm-candidate-select">
          <input type="checkbox" disabled={!handoff.allowed} checked={handoff.allowed && selected.has(candidate.id)} onChange={() => onToggle(candidate.id)} aria-label={t('candidate.select', { title: candidateTitle })} />
        </label>
        <div className="adm-candidate-body">
          <div className="adm-candidate-heading">
            <strong className="adm-candidate-title" title={candidateTitle}>{candidateTitle}</strong>
            <span className="adm-pill" data-tone={confidence.tone}>{confidence.label} · {candidate.confidence}</span>
          </div>
          <span className="adm-candidate-url" title={compactUrl(candidate.url)}>{compactUrl(candidate.url)}</span>
          <span className="adm-candidate-meta" aria-label={t('candidate.summary')}>
            <span className="adm-pill" data-tone="info">{candidate.mediaType}</span>
            <span className="adm-pill">{candidate.extension ?? candidate.mimeType ?? t('candidate.type.unknown')}</span>
            <span className="adm-pill">{candidate.sizeBytes ? formatBytes(candidate.sizeBytes) : t('candidate.size.unknown')}</span>
            <span className="adm-pill">{quality(candidate, t)}</span>
            {duration(candidate.durationSec) ? <span className="adm-pill">{duration(candidate.durationSec)}</span> : null}
          </span>
          {variantsText || subtitlesText ? <span className="adm-candidate-meta">
            {variantsText ? <span className="adm-pill">{variantsText}</span> : null}
            {subtitlesText ? <span className="adm-pill">{subtitlesText}</span> : null}
          </span> : null}
          {candidate.source === 'hls-manifest' || candidate.source === 'dash-manifest' || candidate.mediaType === 'manifest'
            ? <QualitySelector candidate={candidate} onSent={onStreamSent} />
            : null}
          {showHandoffWarnings && !handoff.allowed ? <div className="adm-inline-warning">{t('candidate.notHandoffable', { reason: handoff.reason ?? '' })}</div> : null}{/* Not directly handoffable */}
          <details className="adm-candidate-details">
            <summary>{t('candidate.details')}</summary>{/* Details and evidence */}
            {evidenceSummary(candidate).length > 0 ? <div className="adm-evidence-list" aria-label={t('candidate.evidence.aria')}>
              {evidenceSummary(candidate).map((line, i) => <div key={i} className="adm-evidence-item">{line}</div>)}
              {(candidate.evidence?.length ?? 0) > 4 ? <div className="adm-evidence-item adm-evidence-more">{t('candidate.evidence.more', { n: (candidate.evidence?.length ?? 0) - 4 })}</div> : null}
            </div> : null}
            <DetailGrid items={[
              { label: t('candidate.detail.source'), value: evidence(candidate) },
              { label: t('candidate.detail.confidence'), value: confidenceLevelOf(candidate.confidence) },
              { label: t('candidate.detail.filename'), value: candidate.filename },
              { label: t('candidate.detail.mime'), value: candidate.mimeType },
              { label: t('candidate.detail.finalUrl'), value: compactUrl(candidate.finalUrl) },
              { label: t('candidate.detail.pageUrl'), value: compactUrl(candidate.pageUrl) },
              { label: t('candidate.detail.referrer'), value: compactUrl(candidate.referrer) },
              { label: t('candidate.detail.range'), value: candidate.headers?.acceptRanges },
              { label: t('candidate.detail.etag'), value: candidate.headers?.etag ? redactString(candidate.headers.etag) : undefined },
              { label: t('candidate.detail.lastModified'), value: candidate.headers?.lastModified },
              { label: t('candidate.detail.codecs'), value: candidate.codecs?.join(', ') },
            ]} />
            {candidate.variants?.length ? <div className="adm-detail-note">{t('candidate.bestVariant', { quality: quality(candidate, t), count: candidate.variants.length })}</div> : null}
            {candidate.subtitles?.length ? <div className="adm-detail-note">{t('candidate.subtitleTracks', { tracks: candidate.subtitles.map((track) => track.label ?? track.language ?? track.format ?? 'track').slice(0, 6).join(', ') })}</div> : null}
            <details className="adm-explain-details">
              <summary>{t('candidate.fullExplanation')}</summary>
              <pre className="adm-explain-pre">{explainCandidate(candidate).join('\n')}</pre>
            </details>
          </details>
        </div>
      </article>;
    })}
  </div>;
}
export default CandidateList;
