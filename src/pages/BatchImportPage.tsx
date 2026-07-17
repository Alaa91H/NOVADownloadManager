/* src/pages/BatchImportPage.tsx */
import React, { useState } from 'react';
import { ArrowLeft, Layers, Clipboard, AlertCircle, Sliders } from 'lucide-react';
import { useDialogActions, useTaskActions, useToastActions, useSettingsData, useQueueData, useNavigationActions, useI18n } from '../store/selectors';
import { Button, SelectField, TextField } from '../components/primitives';
import { readClipboardText } from '../utils/clipboard';
import { useEngineCapabilities } from '../capabilities/EngineCapabilityContext';

export const BatchImportPage: React.FC = () => {
  const { closeDialog } = useDialogActions();
  const { triggerBatchDownload } = useTaskActions();
  const { addToast } = useToastActions();
  const settings = useSettingsData();
  const queues = useQueueData();
  const { setActivePage } = useNavigationActions();
  const t = useI18n();
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

  const handleBack = () => {
    closeDialog();
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await readClipboardText();
      if (text) {
        setInputText((prev) => (prev ? `${prev}\n${text}` : text));
      }
    } catch {
      addToast('error', t('toast_error_title'), t('batch_clipboard_error'));
    }
  };

  const handleImport = () => {
    const candidateUrls = inputText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const urls = candidateUrls.filter((line) => engineCapabilities.supportsDirectProtocol(line));

    if (!engineCapabilities.directReady) {
      addToast('error', t('toast_error_title'), t('batch_direct_engine_not_ready'));
      return;
    }

    if (urls.length === 0) {
      addToast(
        'error',
        t('toast_error_title'),
        `${t('batch_no_valid_links')} ${engineCapabilities.directProtocols.join(', ') || '.'}`,
      );
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
    setActivePage('downloads');
  };

  const queueOptions = queues.map((q) => ({ value: q.id, label: q.name }));
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
    <div className="app-page flex-1 flex flex-col min-h-0 overflow-hidden bg-[var(--bg-app)]" dir="ltr">

      {/* HEADER */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)] shrink-0 select-none">
        <button
          type="button"
          onClick={handleBack}
          className="toolbar-btn shrink-0"
          title={t('page_back_tip')}
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="hidden sm:inline">{t('page_back')}</span>
        </button>

        <div className="h-5 w-px bg-[var(--border-color)] shrink-0" />

        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <Layers className="w-4 h-4 text-[var(--accent-primary)] shrink-0" />
          <div className="min-w-0">
            <h1 className="text-sm font-extrabold text-[var(--text-primary)] truncate leading-tight">
              {t('action_add_batch')}
            </h1>
          </div>
        </div>
      </div>

      {/* BODY */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="max-w-3xl mx-auto space-y-4">

          <div className="flex items-center gap-2 p-3 bg-[var(--info-bg)] border border-[var(--info-border)] text-[var(--text-secondary)] rounded-lg text-xs">
            <AlertCircle className="w-5 h-5 text-[var(--accent-primary)] shrink-0" />
            <p className="leading-relaxed">
              {t('batch_desc')}
            </p>
          </div>

          {!engineCapabilities.directReady && (
            <div className="rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] p-2 text-[11px] text-[var(--text-primary)]">
              Direct imports are disabled until the runtime libcurl capability check passes.
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-[var(--text-secondary)]">{t('batch_links_label')}</label>
              <div className="flex gap-1.5">
                <Button
                  onClick={() => {
                    setShowAdvanced((v) => !v);
                  }}
                  variant="ghost"
                  icon={Sliders}
                  size="sm"
                >
                  {t('batch_advanced')}
                </Button>
                <Button
                  onClick={() => {
                    void handlePasteClipboard();
                  }}
                  variant="ghost"
                  icon={Clipboard}
                  size="sm"
                >
                  {t('batch_paste')}
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
                  label={t('batch_queue')}
                  value={queueId}
                  onChange={(e) => {
                    setQueueId(e.target.value);
                  }}
                  options={queueOptions}
                />
                <SelectField
                  label={t('batch_connections')}
                  value={connections}
                  onChange={(e) => {
                    setConnections(Number(e.target.value));
                  }}
                  options={connectionOptions}
                  disabled={!supportsSegmentedDownloads}
                />
                <TextField
                  label={t('batch_save_dir')}
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
                  label={t('batch_referer')}
                  disabled={!supportsDirectOption('referer')}
                  value={referer}
                  onChange={(e) => {
                    setReferer(e.target.value);
                  }}
                  className="font-mono"
                  style={{ direction: 'ltr', textAlign: 'left' }}
                />
                <TextField
                  label={t('batch_user_agent')}
                  disabled={!supportsDirectOption('userAgent')}
                  value={userAgent}
                  onChange={(e) => {
                    setUserAgent(e.target.value);
                  }}
                  className="font-mono"
                  style={{ direction: 'ltr', textAlign: 'left' }}
                />
                <TextField
                  label={t('batch_proxy')}
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
                    label={t('batch_retries')}
                    disabled={!supportsDirectOption('retryCount')}
                    type="number"
                    value={retryCount}
                    onChange={(e) => {
                      setRetryCount(Number(e.target.value));
                    }}
                  />
                  <TextField
                    label={t('batch_timeout')}
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
                  placeholder="Header-Name: value"
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
                  placeholder="name=value; other=value"
                  className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
                  style={{ direction: 'ltr' }}
                  disabled={!supportsDirectOption('cookies')}
                />
              </div>
            </div>
          )}

        </div>
      </div>

      {/* FOOTER */}
      <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border-color)] bg-[var(--bg-sidebar)] shrink-0">
        <button
          onClick={handleBack}
          className="px-4 py-2 text-xs font-bold rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
        >
          {t('btn_cancel')}
        </button>
        <button
          onClick={handleImport}
          className="px-4 py-2 text-xs font-bold rounded-lg bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
          disabled={!engineCapabilities.directReady}
        >
          <Layers className="w-3.5 h-3.5" />
          {t('batch_import_queue')}
        </button>
      </div>
    </div>
  );
};
