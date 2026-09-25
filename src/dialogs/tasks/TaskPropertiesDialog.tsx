/* src/dialogs/tasks/TaskPropertiesDialog.tsx */
import React, { useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { useDialogData, useDialogActions, useTaskActions, useToastActions, useI18n } from '../../store/selectors';
import { tauriClient } from '../../api/tauriClient';
import { novaClient, type TorrentFilePriority, type TorrentTaskDetails } from '../../api/novaClient';
import { TextField, SelectField, Checkbox, DialogButton, Button } from '../../components/primitives';
import type { FileType, DownloadItem } from '../../types/desktop-ui.types';
import { formatBytes } from '../../initialData';
import { useEngineCapabilities } from '../../capabilities/EngineCapabilityContext';
import { isTaskActiveStatus } from '../../utils/taskStatus';

export const TaskPropertiesDialog: React.FC = () => {
  const dialog = useDialogData();
  const { closeDialog } = useDialogActions();
  const { updateTaskProperties } = useTaskActions();
  const { addToast } = useToastActions();
  const t = useI18n();
  const engineCapabilities = useEngineCapabilities();
  const task = dialog.payload as DownloadItem | undefined;

  const [name, setName] = useState(task?.name || '');
  const [url, setUrl] = useState(task?.url || '');
  const [category, setCategory] = useState<FileType>(task?.category || 'other');
  const [connections, setConnections] = useState(task?.connections || 0);
  const [resumable, setResumable] = useState(task?.resumable ?? true);
  const [savePath, setSavePath] = useState(task?.savePath || '');
  const [description, setDescription] = useState(task?.description || '');

  if (!task) {
    return (
      <div className="text-center p-4">
        <p className="text-[var(--danger)] text-xs">{t('task_no_selection')}</p>
        <DialogButton onClick={closeDialog} variant="secondary" className="mt-2">
          {t('btn_close')}
        </DialogButton>
      </div>
    );
  }

  if (task.engine === 'native-torrent') {
    return <TorrentTaskProperties task={task} onClose={closeDialog} />;
  }

  const handlePickDirectory = async () => {
    const picked = await tauriClient.showDirectoryPicker();
    if (picked) {
      setSavePath(`${picked}\\${name}`);
    }
  };

  const supportsRange = engineCapabilities.supportsDirectOption('range');
  const supportsSegmentedDownloads = engineCapabilities.supportsDirectOption('segmented') && supportsRange;
  const normalizedConnections = supportsSegmentedDownloads ? connections : 1;
  const normalizedResumable = supportsRange ? resumable : false;

  const handleSave = () => {
    if (connections > 1 && !supportsSegmentedDownloads) {
      addToast('warning', t('task_connections'), t('task_engine_warning'));
      setConnections(1);
    }
    updateTaskProperties(task.id, {
      name,
      url,
      category,
      fileType: category,
      connections: normalizedConnections,
      resumable: normalizedResumable,
      savePath,
      description,
    });
    closeDialog();
  };

  const categoryOptions = [
    { value: 'document', label: t('documents') },
    { value: 'program', label: t('programs') },
    { value: 'compressed', label: t('compressed') },
    { value: 'video', label: t('videos') },
    { value: 'audio', label: t('audio') },
    { value: 'torrent', label: 'Torrent' },
    { value: 'other', label: t('others') },
  ];

  const connectionOptions = supportsSegmentedDownloads
    ? [
        { value: 0, label: t('task_automatic') },
        { value: 8, label: t('task_conn_8') },
        { value: 16, label: t('task_conn_16') },
        { value: 24, label: t('task_conn_24') },
        { value: 32, label: t('task_conn_32') },
      ]
    : [{ value: 1, label: t('task_conn_single') }];

  return (
    <div className="space-y-4">
      {task.status === 'error' && task.errorMessage ? (
        <div className="bg-[var(--danger-bg)] border border-[var(--danger-border)] rounded-lg p-3">
          <span className="text-[10px] font-semibold text-[var(--danger)] uppercase tracking-wide">
            {t('status_error')}
          </span>
          <p className="text-xs text-[var(--danger)] mt-1 font-mono break-all">{task.errorMessage}</p>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 bg-[var(--bg-hover)] p-3 border border-[var(--border-color)] rounded-lg">
        <div className="flex flex-col">
          <span className="text-[10px] text-[var(--text-muted)]">{t('task_file_size')}</span>
          <span className="text-xs font-semibold font-mono">{formatBytes(task.sizeBytes)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] text-[var(--text-muted)]">{t('task_date_added')}</span>
          <span className="text-xs font-semibold font-mono">{task.dateAdded}</span>
        </div>
        <div className="flex flex-col mt-2">
          <span className="text-[10px] text-[var(--text-muted)]">{t('task_status_label')}</span>
          <span className="text-xs font-semibold capitalize">{task.status}</span>
        </div>
        <div className="flex flex-col mt-2">
          <span className="text-[10px] text-[var(--text-muted)]">{t('task_resume_support')}</span>
          <span className={`text-xs font-semibold ${resumable ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
            {resumable ? t('task_supported') : t('task_not_supported')}
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-hover)]/30 p-2 text-[11px] text-[var(--text-secondary)]">
        {t('task_editing_info')}
      </div>

      <div className="space-y-3">
        <TextField
          label={t('task_file_name')}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />

        <div className="space-y-1">
          <label className="text-xs font-semibold text-[var(--text-secondary)]">{t('task_source_url')}</label>
          <input
            type="text"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
            }}
            className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-xs font-mono transition-all focus:border-[var(--accent-primary)] focus:outline-none p-2 text-left"
            style={{ direction: 'ltr' }}
          />
        </div>

        <div className="flex flex-col gap-1 text-ui">
          <span className="text-xs font-semibold text-[var(--text-secondary)]">{t('task_save_path')}</span>
          <div className="flex gap-2">
            <input
              type="text"
              value={savePath}
              onChange={(e) => {
                setSavePath(e.target.value);
              }}
              className="flex-1 bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-xs px-3 py-1 focus:outline-none font-mono text-left"
              style={{ direction: 'ltr' }}
            />
            <Button
              onClick={() => {
                void handlePickDirectory();
              }}
              variant="secondary"
              icon={HardDrive}
              size="sm"
            >
              {t('task_change')}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SelectField
            label={t('task_category')}
            value={category}
            onChange={(e) => {
              setCategory(e.target.value as FileType);
            }}
            options={categoryOptions}
          />
          <SelectField
            label={t('task_connections')}
            value={normalizedConnections}
            onChange={(e) => {
              setConnections(Number(e.target.value));
            }}
            options={connectionOptions}
            disabled={!supportsSegmentedDownloads}
          />
        </div>

        <TextField
          label={t('task_description')}
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
          }}
        />

        <div className="pt-1 flex items-center gap-2">
          <Checkbox
            label={t('task_resumable_label')}
            checked={resumable}
            onChange={setResumable}
            disabled={!supportsRange}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-4 border-t border-[var(--border-color)]">
        <DialogButton onClick={handleSave} variant="primary">
          {t('task_save_changes')}
        </DialogButton>
        <DialogButton onClick={closeDialog} variant="ghost">
          {t('btn_cancel')}
        </DialogButton>
      </div>
    </div>
  );
};

const TorrentTaskProperties: React.FC<{ task: DownloadItem; onClose: () => void }> = ({ task, onClose }) => {
  const { addToast } = useToastActions();
  const { setTasksWith } = useTaskActions();
  const [details, setDetails] = useState<TorrentTaskDetails | null>(null);
  const [priorities, setPriorities] = useState<TorrentFilePriority[]>([]);
  const [reauthMagnet, setReauthMagnet] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void novaClient
      .torrentDetails(task.id)
      .then((result) => {
        if (cancelled) return;
        setDetails(result);
        setPriorities(result.files.map((file) => file.priority));
        setError('');
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not read torrent details.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  const updateTask = (next: DownloadItem) => {
    setTasksWith((previous) => previous.map((item) => (item.id === next.id ? next : item)));
  };

  const savePriorities = async () => {
    if (!details || saving) return;
    if (priorities.every((priority) => priority === 'skip')) {
      addToast('error', 'Torrent selection', 'At least one torrent file must remain selected.');
      return;
    }
    setSaving(true);
    try {
      const next = await novaClient.updateTorrentFiles(task.id, priorities);
      setDetails(next);
      setPriorities(next.files.map((file) => file.priority));
      updateTask(next.task);
      addToast('success', 'Torrent files', 'Torrent file priorities were updated.');
    } catch (reason) {
      addToast('error', 'Torrent files', reason instanceof Error ? reason.message : 'Could not update file priorities.');
    } finally {
      setSaving(false);
    }
  };

  const reauthorize = async () => {
    if (!reauthMagnet.trim() || saving) return;
    setSaving(true);
    try {
      const next = await novaClient.reauthorizeTorrent(task.id, reauthMagnet.trim());
      updateTask(next);
      const refreshed = await novaClient.torrentDetails(task.id);
      setDetails(refreshed);
      setReauthMagnet('');
      addToast('success', 'Torrent authorization', 'The torrent source was re-authorized for this session.');
    } catch (reason) {
      addToast(
        'error',
        'Torrent authorization',
        reason instanceof Error ? reason.message : 'Could not re-authorize this torrent.',
      );
    } finally {
      setSaving(false);
    }
  };

  const active = isTaskActiveStatus(task.status);

  return (
    <div className="space-y-4">
      {loading && <div className="text-xs text-[var(--text-secondary)]">Loading torrent state…</div>}
      {error && (
        <div className="rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3 text-xs text-[var(--danger)]">
          {error}
        </div>
      )}

      {details && (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <TorrentMetric label="Verified pieces" value={`${String(details.verifiedPieces)}/${String(details.pieceCount)}`} />
            <TorrentMetric label="Downloaded" value={formatBytes(details.selectedCompletedBytes)} />
            <TorrentMetric label="Peer candidates" value={String(details.candidatePeerCount)} />
            <TorrentMetric
              label="Discovery"
              value={`T ${String(details.trackerPeerCount)} · D ${String(details.dhtPeerCount)} · P ${String(details.pexPeerCount)}`}
            />
          </div>

          <div className="space-y-1 rounded-lg border border-[var(--border-color)] bg-[var(--bg-hover)]/20 p-3 text-[10px]">
            <div className="text-[var(--text-muted)]">Info hash</div>
            <div className="break-all font-mono text-[var(--text-primary)]">{details.infoHash}</div>
            <div className="mt-2 text-[var(--text-muted)]">Destination root</div>
            <div className="break-all font-mono text-[var(--text-primary)]">{task.savePath}</div>
            {details.private && <div className="mt-2 font-semibold text-[var(--warning)]">Private torrent</div>}
          </div>

          {details.requiresReauth && (
            <div className="space-y-2 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] p-3">
              <div className="text-xs font-semibold text-[var(--warning)]">Tracker authorization required</div>
              <p className="text-[10px] text-[var(--text-secondary)]">
                NOVA intentionally did not persist credential-bearing tracker parameters. Paste the original magnet to
                authorize this session again.
              </p>
              <div className="flex gap-2">
                <input
                  value={reauthMagnet}
                  onChange={(event) => setReauthMagnet(event.target.value)}
                  placeholder="magnet:?xt=urn:btih:…"
                  className="min-w-0 flex-1 rounded border border-[var(--border-color)] bg-[var(--bg-input)] px-2 py-1.5 font-mono text-[10px] text-[var(--text-primary)]"
                />
                <Button onClick={() => void reauthorize()} variant="secondary" size="sm" disabled={saving}>
                  Re-authorize
                </Button>
              </div>
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-[var(--border-color)]">
            <div className="border-b border-[var(--border-color)] bg-[var(--bg-hover)]/30 px-3 py-2 text-xs font-semibold">
              Torrent files
            </div>
            <div className="max-h-64 overflow-auto">
              {details.files.map((file, index) => (
                <div
                  key={file.index}
                  className="grid grid-cols-[1fr_90px_100px] items-center gap-2 border-b border-[var(--border-color)]/60 px-3 py-2 last:border-b-0"
                >
                  <div className="truncate text-[11px]" title={file.path}>
                    {file.path}
                  </div>
                  <div className="text-right font-mono text-[10px] text-[var(--text-muted)]">
                    {formatBytes(file.length)}
                  </div>
                  <select
                    value={priorities[index] || file.priority}
                    disabled={active || saving}
                    onChange={(event) => {
                      const next = priorities.slice();
                      next[index] = event.target.value as TorrentFilePriority;
                      setPriorities(next);
                    }}
                    className="rounded border border-[var(--border-color)] bg-[var(--bg-input)] px-1.5 py-1 text-[10px]"
                  >
                    <option value="high">High</option>
                    <option value="normal">Normal</option>
                    <option value="skip">Skip</option>
                  </select>
                </div>
              ))}
            </div>
          </div>

          {active && (
            <div className="text-[10px] text-[var(--warning)]">
              Pause the torrent before changing file selection or priority.
            </div>
          )}
        </>
      )}

      <div className="flex justify-end gap-2 border-t border-[var(--border-color)] pt-4">
        {details && !active && (
          <DialogButton onClick={() => void savePriorities()} variant="primary" disabled={saving}>
            Save file priorities
          </DialogButton>
        )}
        <DialogButton onClick={onClose} variant="ghost">
          Close
        </DialogButton>
      </div>
    </div>
  );
};

const TorrentMetric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded border border-[var(--border-color)] bg-[var(--bg-hover)]/20 p-2">
    <div className="text-[9px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
    <div className="mt-1 text-[11px] font-semibold text-[var(--text-primary)]">{value}</div>
  </div>
);

