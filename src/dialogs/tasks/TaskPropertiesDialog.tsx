/* src/dialogs/tasks/TaskPropertiesDialog.tsx */
import React, { useState } from 'react';
import { HardDrive } from 'lucide-react';
import { useDialogData, useDialogActions, useTaskActions, useToastActions, useI18n } from '../../store/selectors';
import { tauriClient } from '../../api/tauriClient';
import { TextField, SelectField, Checkbox, DialogButton, Button } from '../../components/primitives';
import type { FileType, DownloadItem } from '../../types/desktop-ui.types';
import { formatBytes } from '../../initialData';
import { useEngineCapabilities } from '../../capabilities/EngineCapabilityContext';

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
          <span className="text-[10px] font-semibold text-[var(--danger)] uppercase tracking-wide">{t('status_error')}</span>
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
