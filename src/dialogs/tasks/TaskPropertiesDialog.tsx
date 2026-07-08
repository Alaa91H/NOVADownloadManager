/* src/dialogs/tasks/TaskPropertiesDialog.tsx */
import React, { useState } from 'react';
import { HardDrive } from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { tauriClient } from '../../api/tauriClient';
import { TextField, SelectField, Checkbox, DialogButton, Button } from '../../components/primitives';
import { FileType, DownloadItem } from '../../types/desktop-ui.types';
import { formatBytes } from '../../initialData';
import { useEngineCapabilities } from '../../capabilities/EngineCapabilityContext';

export const TaskPropertiesDialog: React.FC = () => {
  const { dialog, closeDialog, updateTaskProperties, addToast, t } = useAppStore();
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
        <p className="text-red-500 text-xs">No download was selected.</p>
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
      addToast('warning', 'Engine capabilities', 'The linked libcurl engine does not expose range/segmented downloads. Connections were reduced to 1.');
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
    { value: 'document', label: 'Documents' },
    { value: 'program', label: 'Programs & Apps' },
    { value: 'compressed', label: 'Compressed Files' },
    { value: 'video', label: 'Videos' },
    { value: 'audio', label: 'Audio' },
    { value: 'other', label: 'Other Files' },
  ];

  const connectionOptions = supportsSegmentedDownloads
    ? [
        { value: 0, label: 'Automatic' },
        { value: 8, label: '8 connections' },
        { value: 16, label: '16 connections' },
        { value: 24, label: '24 connections' },
        { value: 32, label: '32 connections' },
      ]
    : [{ value: 1, label: 'Single connection (range unavailable)' }];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 bg-[var(--bg-hover)] p-3 border border-[var(--border-color)] rounded-lg">
        <div className="flex flex-col">
          <span className="text-[10px] text-[var(--text-muted)]">File Size</span>
          <span className="text-xs font-semibold font-mono">{formatBytes(task.sizeBytes)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] text-[var(--text-muted)]">Date Added</span>
          <span className="text-xs font-semibold font-mono">{task.dateAdded}</span>
        </div>
        <div className="flex flex-col mt-2">
          <span className="text-[10px] text-[var(--text-muted)]">Status</span>
          <span className="text-xs font-semibold capitalize">{task.status}</span>
        </div>
        <div className="flex flex-col mt-2">
          <span className="text-[10px] text-[var(--text-muted)]">Resume Support</span>
          <span className={`text-xs font-semibold ${resumable ? 'text-green-500' : 'text-red-500'}`}>
            {resumable ? 'Supported' : 'Not supported'}
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-hover)]/30 p-2 text-[11px] text-[var(--text-secondary)]">
        Task editing is capability-aware. Direct-engine thread and resume controls are disabled unless linked libcurl reports range/segmented support.
      </div>

      <div className="space-y-3">
        <TextField
          label="File Name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />

        <div className="space-y-1">
          <label className="text-xs font-semibold text-[var(--text-secondary)]">Source URL</label>
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
          <span className="text-xs font-semibold text-[var(--text-secondary)]">Save Path</span>
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
              Change
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SelectField
            label="Category"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value as FileType);
            }}
            options={categoryOptions}
          />
          <SelectField
            label="Connections"
            value={normalizedConnections}
            onChange={(e) => {
              setConnections(Number(e.target.value));
            }}
            options={connectionOptions}
            disabled={!supportsSegmentedDownloads}
          />
        </div>

        <TextField
          label="Description"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
          }}
        />

        <div className="pt-1 flex items-center gap-2">
          <Checkbox label="Treat this download as resumable" checked={resumable} onChange={setResumable} disabled={!supportsRange} />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-4 border-t border-[var(--border-color)]">
        <DialogButton onClick={handleSave} variant="primary">
          Save Changes
        </DialogButton>
        <DialogButton onClick={closeDialog} variant="ghost">
          {t('btn_cancel')}
        </DialogButton>
      </div>
    </div>
  );
};
