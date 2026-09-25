import React, { useCallback, useEffect, useState } from 'react';

import { novaClient, type TorrentTaskDetails } from '../../api/novaClient';
import { formatBytes } from '../../initialData';
import { formatElapsed } from '../../utils/formatUtils';

interface TorrentSeedingControlsProps {
  taskId: string;
}

export const TorrentSeedingControls: React.FC<TorrentSeedingControlsProps> = ({ taskId }) => {
  const [details, setDetails] = useState<TorrentTaskDetails | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [ratioLimit, setRatioLimit] = useState('');
  const [timeLimitMinutes, setTimeLimitMinutes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const applyDetails = useCallback((next: TorrentTaskDetails) => {
    setDetails(next);
    setEnabled(next.seedingEnabled);
    setRatioLimit(next.seedRatioLimit == null ? '' : String(next.seedRatioLimit));
    setTimeLimitMinutes(
      next.seedTimeLimitSeconds == null
        ? ''
        : String(Math.round((next.seedTimeLimitSeconds / 60) * 100) / 100),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void novaClient
      .torrentDetails(taskId)
      .then((next) => {
        if (!cancelled) applyDetails(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Could not load torrent seeding state.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyDetails, taskId]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void novaClient
        .torrentDetails(taskId)
        .then((next) => {
          if (!cancelled) setDetails(next);
        })
        .catch(() => {
          // Keep the last successful snapshot; the primary load/save path
          // already surfaces actionable errors to the user.
        });
    };
    const timer = window.setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [taskId]);

  const save = async () => {
    if (saving) return;
    const ratio = ratioLimit.trim() === '' ? null : Number(ratioLimit);
    const minutes = timeLimitMinutes.trim() === '' ? null : Number(timeLimitMinutes);
    if (ratio != null && (!Number.isFinite(ratio) || ratio < 0)) {
      setError('Ratio limit must be a non-negative number.');
      return;
    }
    if (minutes != null && (!Number.isFinite(minutes) || minutes < 0)) {
      setError('Time limit must be a non-negative number of minutes.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const next = await novaClient.updateTorrentSeeding(taskId, {
        enabled,
        ratioLimit: ratio,
        timeLimitSeconds: minutes == null ? null : Math.round(minutes * 60),
      });
      applyDetails(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update torrent seeding policy.');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !details) {
    return (
      <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-hover)]/20 p-3 text-[10px] text-[var(--text-muted)]">
        Loading torrent seeding state…
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-hover)]/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-bold text-[var(--text-primary)]">Torrent seeding</div>
          <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">
            {details?.seedLimitReached
              ? 'Configured seeding limit reached.'
              : details?.seedingActive
                ? 'Uploading verified pieces to peers.'
                : enabled
                  ? 'Enabled; waiting for eligible peer requests.'
                  : 'Disabled for this torrent.'}
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[10px] font-semibold text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="h-4 w-4 rounded border-[var(--border-color)] bg-[var(--bg-input)] text-[var(--accent-primary)] focus:ring-[var(--accent-primary)]"
          />
          Enabled
        </label>
      </div>

      {details ? (
        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] md:grid-cols-4">
          <SeedMetric label="Uploaded" value={formatBytes(details.uploadedBytes)} />
          <SeedMetric label="Ratio" value={details.seedRatio.toFixed(3)} />
          <SeedMetric label="Seed time" value={formatElapsed(details.seededSeconds)} />
          <SeedMetric label="Peers" value={String(details.activeSeedConnections)} />
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-[10px] text-[var(--text-muted)]">
          Ratio limit
          <input
            type="number"
            min={0}
            max={1000}
            step={0.1}
            value={ratioLimit}
            disabled={!enabled || saving}
            placeholder="Unlimited"
            onChange={(event) => setRatioLimit(event.target.value)}
            className="mt-1 w-full rounded border border-[var(--border-color)] bg-[var(--bg-input)] px-2 py-1.5 text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent-primary)] disabled:opacity-50"
          />
        </label>
        <label className="text-[10px] text-[var(--text-muted)]">
          Time limit (minutes)
          <input
            type="number"
            min={0}
            step={1}
            value={timeLimitMinutes}
            disabled={!enabled || saving}
            placeholder="Unlimited"
            onChange={(event) => setTimeLimitMinutes(event.target.value)}
            className="mt-1 w-full rounded border border-[var(--border-color)] bg-[var(--bg-input)] px-2 py-1.5 text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent-primary)] disabled:opacity-50"
          />
        </label>
      </div>

      {details?.requiresReauth ? (
        <div className="mt-2 text-[10px] text-[var(--warning)]">
          Tracker authorization is required before this torrent can seed.
        </div>
      ) : null}
      {error ? <div className="mt-2 text-[10px] text-[var(--danger)]">{error}</div> : null}

      {details ? <TorrentSwarmTelemetry details={details} /> : null}

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded border border-[var(--border-color)] bg-[var(--bg-button)] px-3 py-1.5 text-[10px] font-bold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
        >
          {saving ? 'Applying…' : 'Apply seeding policy'}
        </button>
      </div>
    </div>
  );
};

const SeedMetric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded border border-[var(--border-color)]/70 bg-[var(--bg-input)] px-2 py-1.5">
    <div className="text-[9px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
    <div className="mt-0.5 font-mono text-[10px] font-semibold text-[var(--text-primary)]">{value}</div>
  </div>
);

const TorrentSwarmTelemetry: React.FC<{ details: TorrentTaskDetails }> = ({ details }) => {
  const peers = details.swarmPeers.slice(0, 32);
  const trackers = details.trackerTelemetry.slice(0, 16);
  const dhtEndpoints = [
    details.dhtIpv4Port == null ? null : `IPv4 UDP :${details.dhtIpv4Port}`,
    details.dhtIpv6Port == null ? null : `IPv6 UDP :${details.dhtIpv6Port}`,
  ].filter(Boolean).join(' · ');

  return (
    <div className="mt-3 space-y-2 border-t border-[var(--border-color)]/70 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[10px] font-bold text-[var(--text-primary)]">Live swarm</div>
          <div className="text-[9px] text-[var(--text-muted)]">
            {dhtEndpoints || 'DHT listener unavailable'} · {details.dhtRoutingNodes} routing nodes
          </div>
        </div>
        <div className="text-[9px] text-[var(--text-muted)]">
          {details.swarmPeers.length} peers · {details.trackerTelemetry.length} trackers
        </div>
      </div>

      <div className="grid gap-2 xl:grid-cols-2">
        <div className="overflow-hidden rounded border border-[var(--border-color)]/70 bg-[var(--bg-input)]">
          <div className="border-b border-[var(--border-color)]/70 px-2 py-1.5 text-[9px] font-bold uppercase tracking-wide text-[var(--text-muted)]">
            Peers
          </div>
          <div className="max-h-40 overflow-auto">
            {peers.length === 0 ? (
              <div className="px-2 py-3 text-[9px] text-[var(--text-muted)]">No peer activity yet.</div>
            ) : (
              peers.map((peer) => (
                <div
                  key={`${peer.direction}-${peer.address}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-[var(--border-color)]/40 px-2 py-1.5 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[9px] text-[var(--text-primary)]">{peer.address}</div>
                    <div className="text-[8px] text-[var(--text-muted)]">
                      {peer.direction} · {peer.state}
                      {peer.lastError ? ` · ${peer.lastError}` : ''}
                    </div>
                  </div>
                  <div className="text-right font-mono text-[8px] text-[var(--text-secondary)]">
                    <div>↓ {formatBytes(peer.downloadedBytes)}</div>
                    <div>↑ {formatBytes(peer.uploadedBytes)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="overflow-hidden rounded border border-[var(--border-color)]/70 bg-[var(--bg-input)]">
          <div className="border-b border-[var(--border-color)]/70 px-2 py-1.5 text-[9px] font-bold uppercase tracking-wide text-[var(--text-muted)]">
            Trackers
          </div>
          <div className="max-h-40 overflow-auto">
            {trackers.length === 0 ? (
              <div className="px-2 py-3 text-[9px] text-[var(--text-muted)]">No tracker activity yet.</div>
            ) : (
              trackers.map((tracker) => (
                <div
                  key={tracker.endpoint}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-[var(--border-color)]/40 px-2 py-1.5 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[9px] text-[var(--text-primary)]">{tracker.endpoint}</div>
                    <div className="text-[8px] text-[var(--text-muted)]">
                      {tracker.state} · {tracker.lastEvent}
                      {tracker.lastError ? ` · ${tracker.lastError}` : ''}
                    </div>
                  </div>
                  <div className="text-right font-mono text-[8px] text-[var(--text-secondary)]">
                    <div>{tracker.peerCount} peers</div>
                    <div>{tracker.intervalSeconds == null ? '—' : `${tracker.intervalSeconds}s`}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
