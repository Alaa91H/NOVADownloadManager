import React from 'react';
import { Candidate } from '../../contracts/candidate.schema';
import { handoffPolicyDecision } from '../../security/handoff-policy';
import { capabilitiesForCandidate } from '../../contracts/capabilities.schema';
import { formatFileSize, formatDuration, qualityBadge } from '../../pipeline/quality-detector';
import { BridgeState } from '../../core/app-state';
import { Download, Send, Search } from 'lucide-react';

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

function shortTitle(c: Candidate): string {
  return c.filename?.slice(0, 48) || c.url?.split('/').pop()?.split('?')[0]?.slice(0, 48) || c.url?.slice(0, 48) || '—';
}

function qualityLabel(c: Candidate): string {
  if (c.height) return c.height >= 2160 ? '4K' : `${c.height}p`;
  if (c.bitrate) return `${Math.round(c.bitrate / 1000)}k`;
  return '';
}

function formatSize(c: Candidate): string {
  if (!c.sizeBytes) return '';
  return formatFileSize(c.sizeBytes) ?? '';
}

function formatDur(c: Candidate): string {
  return formatDuration(c.durationSec) ?? '';
}

export type DenseCandidateListProps = {
  candidates: Candidate[];
  bridge?: BridgeState;
  busy: boolean;
  onSend(candidate: Candidate): void;
  onSendAll(candidates: Candidate[]): void;
  onAnalyze?(candidate: Candidate): void;
};

export function DenseCandidateList({ candidates, bridge, busy, onSend, onSendAll, onAnalyze }: DenseCandidateListProps) {
  if (candidates.length === 0) {
    return (
      <div className="nova-dropdown-empty">
        No media captured
      </div>
    );
  }

  const handoffable = candidates.filter((c) => {
    const policy = handoffPolicyDecision(c);
    const caps = capabilitiesForCandidate(c, bridge?.capabilities);
    return policy.allowed && caps.supported;
  });

  return (
    <div className="nova-dropdown-list">
      <div className="nova-dropdown-scroll">
        {candidates.map((c) => {
          const policy = handoffPolicyDecision(c);
          const caps = capabilitiesForCandidate(c, bridge?.capabilities);
          const supported = policy.allowed && caps.supported;
          const badge = qualityBadge(c.width, c.height);
          const size = formatSize(c);
          const dur = formatDur(c);
          const ql = qualityLabel(c);

          return (
            <div
              key={c.id}
              className="nova-dense-row"
              data-disabled={!supported}
            >
              <span className="nova-dense-icon" data-type={c.mediaType}>
                {mediaIcon(c.mediaType)}
              </span>
              <span className="nova-dense-title" title={c.filename || c.url}>
                {shortTitle(c)}
              </span>
              {ql && (
                <span
                  className="nova-dense-ql"
                  style={{ '--badge-color': badge.color } as React.CSSProperties}
                >
                  {ql}
                </span>
              )}
              {size && <span className="nova-dense-meta">{size}</span>}
              {dur && <span className="nova-dense-meta">{dur}</span>}
              <button
                type="button"
                className="nova-dense-dl"
                disabled={busy || !supported}
                onClick={() => onSend(c)}
                title={supported ? 'Download' : caps.supported ? 'Blocked' : 'Not supported'}
              >
                <Download style={{ width: 10, height: 10 }} />
              </button>
              {onAnalyze && bridge?.canSend && (
                <button
                  type="button"
                  className="nova-dense-dl"
                  disabled={busy}
                  onClick={() => onAnalyze(c)}
                  title="Analyze formats"
                  style={{ opacity: 0.6 }}
                >
                  <Search style={{ width: 10, height: 10 }} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {handoffable.length > 0 && (
        <div className="nova-dropdown-footer">
          <button
            type="button"
            className="nova-dropdown-send-all"
            disabled={busy}
            onClick={() => onSendAll(handoffable)}
          >
            <Send style={{ width: 10, height: 10 }} />
            <span>Send All ({handoffable.length})</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default DenseCandidateList;
