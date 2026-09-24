import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, FolderOpen, Loader2, Magnet, ShieldCheck } from 'lucide-react';

import { novaClient, type TorrentAnalysis, type TorrentFilePriority } from '../../api/novaClient';
import { tauriClient } from '../../api/tauriClient';
import { useEngineCapabilities } from '../../capabilities/EngineCapabilityContext';
import { formatBytes } from '../../initialData';
import {
  useDialogActions,
  useDialogData,
  useSettingsData,
  useTaskActions,
  useToastActions,
} from '../../store/selectors';
import { clearClipboardIfTextMatches } from '../../utils/clipboard';

export const TorrentDownloadDialog: React.FC = () => {
  const dialog = useDialogData();
  const { closeDialog, openDialog } = useDialogActions();
  const settings = useSettingsData();
  const { setSelectedTaskId, setTasksWith } = useTaskActions();
  const { addToast } = useToastActions();
  const capabilities = useEngineCapabilities();

  const magnetUri = typeof dialog.payload === 'string' ? dialog.payload.trim() : '';
  const latestMagnetRef = useRef(magnetUri);
  const [analysis, setAnalysis] = useState<TorrentAnalysis | null>(null);
  const [priorities, setPriorities] = useState<TorrentFilePriority[]>([]);
  const [savePath, setSavePath] = useState(
    settings.saveAndCategories.categoryFolders.torrent ||
      settings.saveAndCategories.defaultFolder ||
      '',
  );
  const [connections, setConnections] = useState(
    settings.connection.maxConnections > 0 ? settings.connection.maxConnections : 8,
  );
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    latestMagnetRef.current = magnetUri;
  }, [magnetUri]);

  useEffect(() => {
    return () => {
      if (settings.extra.preventClipboardHistory) {
        void clearClipboardIfTextMatches(latestMagnetRef.current);
      }
    };
  }, [settings.extra.preventClipboardHistory]);

  useEffect(() => {
    if (savePath) return;
    let cancelled = false;
    void tauriClient.getDownloadsDir().then((dir) => {
      if (!cancelled && dir) setSavePath(dir);
    });
    return () => {
      cancelled = true;
    };
  }, [savePath]);

  useEffect(() => {
    if (!magnetUri || !capabilities.torrentReady) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setAnalysis(null);

    void novaClient
      .analyzeTorrent(magnetUri)
      .then((result) => {
        if (cancelled) return;
        setAnalysis(result);
        setPriorities(result.files.map((file) => file.priority || 'normal'));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Torrent analysis failed.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [magnetUri, capabilities.torrentReady]);

  const selectedFileCount = useMemo(
    () => priorities.reduce((total, priority) => total + (priority === 'skip' ? 0 : 1), 0),
    [priorities],
  );
  const selectedBytes = useMemo(() => {
    if (!analysis) return 0;
    return analysis.files.reduce(
      (total, file, index) => total + (priorities[index] === 'skip' ? 0 : file.length),
      0,
    );
  }, [analysis, priorities]);

  const setAll = (priority: TorrentFilePriority) => {
    if (!analysis) return;
    setPriorities(analysis.files.map(() => priority));
  };

  const handlePickDirectory = async () => {
    const picked = await tauriClient.showDirectoryPicker(savePath || undefined);
    if (picked) setSavePath(picked);
  };

  const createTorrent = async (startImmediately: boolean) => {
    if (!analysis || creating) return;
    if (!savePath.trim()) {
      addToast('error', 'Torrent destination', 'Choose a destination directory first.');
      return;
    }
    if (selectedFileCount === 0) {
      addToast('error', 'Torrent selection', 'Select at least one file to download.');
      return;
    }

    setCreating(true);
    setError('');
    try {
      const task = await novaClient.createTorrent({
        analysisId: analysis.analysisId,
        savePath: savePath.trim(),
        startImmediately,
        filePriorities: priorities,
        connections: Math.max(1, Math.min(32, connections || 1)),
      });

      setTasksWith((previous) => [task, ...previous.filter((item) => item.id !== task.id)]);
      setSelectedTaskId(task.id);
      addToast(
        'success',
        'Torrent added',
        `"${task.name}" was added with ${String(selectedFileCount)} selected file${selectedFileCount === 1 ? '' : 's'}.`,
      );

      if (startImmediately) {
        openDialog('activeProgress', task);
      } else {
        closeDialog();
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'NOVA could not create the torrent task.';
      setError(message);
      addToast('error', 'Torrent download', message);
    } finally {
      setCreating(false);
    }
  };

  if (!capabilities.torrentReady) {
    return (
      <div className="space-y-3 text-sm">
        <div className="rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3 text-[var(--text-primary)]">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 text-[var(--danger)]" />
            Native torrent engine is unavailable
          </div>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            {capabilities.torrentBlockedReason() || 'Torrent routing is not enabled by the daemon.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-hover)]/25 p-3">
        <div className="flex items-start gap-3">
          <Magnet className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-primary)]" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-[var(--text-primary)]">Native BitTorrent download</div>
            <div className="mt-1 truncate font-mono text-[10px] text-[var(--text-muted)]" title={magnetUri}>
              {magnetUri}
            </div>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-[var(--success)]">
            <ShieldCheck className="h-3.5 w-3.5" />
            NOVA native
          </div>
        </div>
      </div>

      {loading && (
        <div className="flex min-h-36 items-center justify-center gap-2 rounded-lg border border-[var(--border-color)] text-xs text-[var(--text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Discovering peers and retrieving signed torrent metadata…
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3 text-xs text-[var(--text-primary)]">
          {error}
        </div>
      )}

      {analysis && (
        <>
          <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
            <InfoCard label="Name" value={analysis.name} />
            <InfoCard label="Selected" value={formatBytes(selectedBytes)} />
            <InfoCard label="Pieces" value={String(analysis.pieceCount)} />
            <InfoCard label="Peers found" value={String(analysis.peerCount)} />
          </div>

          <div className="grid grid-cols-[1fr_130px] gap-3">
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Destination directory
              </label>
              <div className="relative">
                <input
                  value={savePath}
                  onChange={(event) => setSavePath(event.target.value)}
                  className="w-full rounded border border-[var(--border-color)] bg-[var(--bg-input)] px-2.5 py-2 pr-9 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                  style={{ direction: 'ltr' }}
                />
                <button
                  type="button"
                  onClick={() => void handlePickDirectory()}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  title="Choose destination directory"
                >
                  <FolderOpen className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Parallel pieces
              </label>
              <input
                type="number"
                min={1}
                max={32}
                value={connections}
                onChange={(event) => setConnections(Number(event.target.value) || 1)}
                className="w-full rounded border border-[var(--border-color)] bg-[var(--bg-input)] px-2.5 py-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
              />
            </div>
          </div>

          {analysis.private && (
            <div className="rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] p-2.5 text-[11px] text-[var(--warning)]">
              Private torrent: DHT/PEX fallback is disabled by protocol policy. Tracker authorization is kept in memory
              and is never written to NOVA's persisted task state.
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-[var(--border-color)]">
            <div className="flex items-center justify-between border-b border-[var(--border-color)] bg-[var(--bg-hover)]/35 px-3 py-2">
              <div className="text-xs font-semibold text-[var(--text-primary)]">
                Files · {selectedFileCount}/{analysis.files.length}
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setAll('normal')}
                  className="rounded border border-[var(--border-color)] px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setAll('high')}
                  className="rounded border border-[var(--border-color)] px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                >
                  High all
                </button>
              </div>
            </div>
            <div className="max-h-64 overflow-auto">
              {analysis.files.map((file, index) => (
                <div
                  key={file.index}
                  className="grid grid-cols-[1fr_90px_100px] items-center gap-2 border-b border-[var(--border-color)]/60 px-3 py-2 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[11px] text-[var(--text-primary)]" title={file.path}>
                      {file.path}
                    </div>
                  </div>
                  <div className="text-right font-mono text-[10px] text-[var(--text-muted)]">
                    {formatBytes(file.length)}
                  </div>
                  <select
                    aria-label={`Priority for ${file.path}`}
                    value={priorities[index] || 'normal'}
                    onChange={(event) => {
                      const next = priorities.slice();
                      next[index] = event.target.value as TorrentFilePriority;
                      setPriorities(next);
                    }}
                    className="rounded border border-[var(--border-color)] bg-[var(--bg-input)] px-1.5 py-1 text-[10px] text-[var(--text-primary)]"
                  >
                    <option value="high">High</option>
                    <option value="normal">Normal</option>
                    <option value="skip">Skip</option>
                  </select>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-[var(--border-color)] pt-3">
            <div className="font-mono text-[9px] text-[var(--text-muted)]">
              SHA-1 info hash: {analysis.infoHash}
              {analysis.usedDht ? ' · DHT fallback used' : ''}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={closeDialog}
                disabled={creating}
                className="rounded px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void createTorrent(false)}
                disabled={creating || selectedFileCount === 0}
                className="rounded border border-[var(--border-color)] bg-[var(--bg-button)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
              >
                Add to queue
              </button>
              <button
                type="button"
                onClick={() => void createTorrent(true)}
                disabled={creating || selectedFileCount === 0}
                className="flex items-center gap-1.5 rounded bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Start torrent
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const InfoCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="min-w-0 rounded border border-[var(--border-color)] bg-[var(--bg-hover)]/20 p-2">
    <div className="text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
    <div className="mt-1 truncate text-[11px] text-[var(--text-primary)]" title={value}>
      {value}
    </div>
  </div>
);
