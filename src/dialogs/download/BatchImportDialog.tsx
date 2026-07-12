/* src/dialogs/download/BatchImportDialog.tsx */
import React, { useState } from 'react';
import { Layers, Clipboard, AlertCircle, Sliders } from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { DialogButton, Button, SelectField, TextField } from '../../components/primitives';
import { DegradedBanner } from '../../components/primitives/DegradedBanner';
import { readClipboardText } from '../../utils/clipboard';
import { useEngineCapabilities } from '../../capabilities/EngineCapabilityContext';

export const BatchImportDialog: React.FC = () => {
  const { closeDialog, triggerBatchDownload, addToast, settings, queues, t, isDegradedMode } = useAppStore();
  const engineCapabilities = useEngineCapabilities();
  const [inputText, setInputText] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [queueId, setQueueId] = useState('main');
  const [saveDirectory, setSaveDirectory] = useState(
    settings.saveAndCategories.categoryFolders.other || settings.saveAndCategories.defaultFolder || '',
  );
  const [connections, setConnections] = useState<number>(0);
  const [referer, setReferer] = useState('');
  const [userAgent, setUserAgent] = useState(settings.extra.userAgent || '');
  const [proxy, setProxy] = useState('');
  const [headers, setHeaders] = useState('');
  const [cookies, setCookies] = useState('');
  const [retryCount, setRetryCount] = useState<number>(3);
  const [timeoutSec, setTimeoutSec] = useState<number>(60);

  const supportsSegmentedDownloads =
    engineCapabilities.supportsDirectOption('segmented') && engineCapabilities.supportsDirectOption('range');
  const supportsDirectOption = (key: string) => engineCapabilities.supportsDirectOption(key);

  const handlePasteClipboard = async () => {
    try {
      const text = await readClipboardText();
      if (text) {
        setInputText((prev) => (prev ? `${prev}\n${text}` : text));
      }
    } catch {
      addToast('error', t('toast_error_title'), t('batch_toast_clipboard_read'));
    }
  };

  const handleImport = () => {
    const candidateUrls = inputText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const urls = candidateUrls.filter((line) => engineCapabilities.supportsDirectProtocol(line));

    if (!engineCapabilities.directReady) {
      addToast('error', t('toast_error_title'), t('batch_toast_engine_not_ready'));
      return;
    }

    if (urls.length === 0) {
      addToast('error', t('toast_error_title'), t('batch_toast_no_valid_links', { protocols: engineCapabilities.directProtocols.join(', ') || 'none' }));
      return;
    }

    const directOptions = engineCapabilities.sanitizeDirectOptions({
      referer: referer.trim() || undefined,
      userAgent: userAgent.trim() || undefined,
      proxy: proxy.trim() || undefined,
      headers: headers.trim() || undefined,
      cookies: cookies.trim() || undefined,
      retryCount: retryCount > 0 ? retryCount : undefined,
      timeoutSec: timeoutSec > 0 ? timeoutSec : undefined,
      segmented: supportsSegmentedDownloads && connections > 1 ? true : undefined,
    });

    void triggerBatchDownload(urls, {
      queueId,
      connections: supportsSegmentedDownloads ? connections : 1,
      saveDirectory: saveDirectory.trim() || undefined,
      description: 'Batch import',
      directOptions,
    });
    closeDialog();
  };

  const queueOptions = queues.map((q) => ({ value: q.id, label: q.name }));
  const connectionOptions = supportsSegmentedDownloads
    ? [
        { value: 0, label: t('add_dl_auto_default') },
        { value: 8, label: t('add_dl_threads_8') },
        { value: 16, label: t('add_dl_threads_16') },
        { value: 24, label: t('add_dl_threads_24') },
        { value: 32, label: t('add_dl_threads_32') },
      ]
    : [{ value: 1, label: t('add_dl_single_conn') }];

  return (
    <div className="space-y-4">
      {isDegradedMode && (
        <DegradedBanner title={t('dialog_degraded_title')} description={t('dialog_degraded_desc')} />
      )}
      <div className="flex items-center gap-2 p-3 bg-blue-500/10 border border-blue-500/20 text-[var(--text-secondary)] rounded-lg text-xs">
        <AlertCircle className="w-5 h-5 text-[var(--accent-primary)] shrink-0" />
        <p className="leading-relaxed">{t('batch_desc')}</p>
      </div>
      {!engineCapabilities.directReady && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-200">
          {t('batch_unavailable')}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-[var(--text-secondary)]">{t('batch_field_links_label')}</label>
          <div className="flex gap-1.5">
            <Button
              onClick={() => {
                setShowAdvanced((v) => !v);
              }}
              variant="ghost"
              icon={Sliders}
              size="sm"
            >
              {t('batch_btn_advanced')}
            </Button>
            <Button
              onClick={() => {
                void handlePasteClipboard();
              }}
              variant="ghost"
              icon={Clipboard}
              size="sm"
            >
              {t('batch_btn_paste')}
            </Button>
          </div>
        </div>
        <textarea
          rows={8}
          placeholder=""
          value={inputText}
          onChange={(e) => {
            setInputText(e.target.value);
          }}
          className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg p-3 text-xs font-mono transition-all focus:border-[var(--accent-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)] text-left"
          style={{ direction: 'ltr' }}
        />
      </div>

      {showAdvanced && (
        <div className="p-3 bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-lg space-y-3 animate-in fade-in slide-in-from-top-2 duration-150">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <SelectField
              label={t('add_dl_queue')}
              value={queueId}
              onChange={(e) => {
                setQueueId(e.target.value);
              }}
              options={queueOptions}
            />
            <SelectField
              label={t('add_dl_threads')}
              value={connections}
              onChange={(e) => {
                setConnections(Number(e.target.value));
              }}
              options={connectionOptions}
              disabled={!supportsSegmentedDownloads}
            />
            <TextField
              label={t('add_dl_save_path')}
              value={saveDirectory}
              onChange={(e) => {
                setSaveDirectory(e.target.value);
              }}
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <TextField
              label={t('add_dl_referer')}
              disabled={!supportsDirectOption('referer')}
              value={referer}
              onChange={(e) => {
                setReferer(e.target.value);
              }}
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('add_dl_user_agent')}
              disabled={!supportsDirectOption('userAgent')}
              value={userAgent}
              onChange={(e) => {
                setUserAgent(e.target.value);
              }}
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('add_dl_proxy')}
              disabled={!supportsDirectOption('proxy')}
              value={proxy}
              onChange={(e) => {
                setProxy(e.target.value);
              }}
              placeholder="http://127.0.0.1:8080"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label={t('add_dl_retries')}
                disabled={!supportsDirectOption('retryCount')}
                type="number"
                value={retryCount}
                onChange={(e) => {
                  setRetryCount(Number(e.target.value));
                }}
              />
              <TextField
                label={t('add_dl_timeout')}
                disabled={!supportsDirectOption('timeoutSec')}
                type="number"
                value={timeoutSec}
                onChange={(e) => {
                  setTimeoutSec(Number(e.target.value));
                }}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <textarea
              rows={3}
              value={headers}
              onChange={(e) => {
                setHeaders(e.target.value);
              }}
              placeholder={t('add_dl_headers_placeholder')}
              className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
              style={{ direction: 'ltr' }}
              disabled={!supportsDirectOption('headers')}
            />
            <textarea
              rows={3}
              value={cookies}
              onChange={(e) => {
                setCookies(e.target.value);
              }}
              placeholder={t('add_dl_cookies_placeholder')}
              className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
              style={{ direction: 'ltr' }}
              disabled={!supportsDirectOption('cookies')}
            />
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-4 border-t border-[var(--border-color)]">
        <DialogButton onClick={handleImport} variant="primary" icon={Layers} disabled={!engineCapabilities.directReady}>
          {t('batch_btn_import')}
        </DialogButton>
        <DialogButton onClick={closeDialog} variant="ghost">
          {t('btn_cancel')}
        </DialogButton>
      </div>
    </div>
  );
};
