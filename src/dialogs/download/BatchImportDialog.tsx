/* src/dialogs/download/BatchImportDialog.tsx */
import React, { useState } from 'react';
import { Layers, Clipboard, AlertCircle, Sliders } from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { DialogButton, Button, SelectField, TextField } from '../../components/primitives';
import { readClipboardText } from '../../utils/clipboard';

export const BatchImportDialog: React.FC = () => {
  const { closeDialog, triggerBatchDownload, addToast, settings, queues, t } = useAppStore();
  const [inputText, setInputText] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [queueId, setQueueId] = useState('main');
  const [saveDirectory, setSaveDirectory] = useState(settings.saveAndCategories.categoryFolders.other || settings.saveAndCategories.defaultFolder || '');
  const [connections, setConnections] = useState<number>(0);
  const [referer, setReferer] = useState('');
  const [userAgent, setUserAgent] = useState(settings.extra.userAgent || '');
  const [proxy, setProxy] = useState('');
  const [headers, setHeaders] = useState('');
  const [cookies, setCookies] = useState('');
  const [retryCount, setRetryCount] = useState<number>(3);
  const [timeoutSec, setTimeoutSec] = useState<number>(60);
  const [rawOptions, setRawOptions] = useState('');

  const handlePasteClipboard = async () => {
    try {
      const text = await readClipboardText();
      if (text) {
        setInputText(prev => (prev ? `${prev}\n${text}` : text));
      }
    } catch {
      addToast('error', t('toast_error_title'), 'Unable to read clipboard automatically. Please paste manually.');
    }
  };

  const handleImport = () => {
    const urls = inputText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('http://') || line.startsWith('https://'));

    if (urls.length === 0) {
      addToast('error', t('toast_error_title'), 'No valid download links found. Links must start with http:// or https://.');
      return;
    }

    triggerBatchDownload(urls, {
      queueId,
      connections,
      saveDirectory: saveDirectory.trim() || undefined,
      description: 'Batch import',
      directOptions: {
        referer: referer.trim() || undefined,
        userAgent: userAgent.trim() || undefined,
        proxy: proxy.trim() || undefined,
        headers: headers.trim() || undefined,
        cookies: cookies.trim() || undefined,
        retryCount: retryCount > 0 ? retryCount : undefined,
        timeoutSec: timeoutSec > 0 ? timeoutSec : undefined,
        rawOptions: rawOptions.trim() || undefined,
      },
    });
    closeDialog();
  };

  const queueOptions = queues.map(q => ({ value: q.id, label: q.name }));
  const connectionOptions = [
    { value: 0, label: 'Automatic' },
    { value: 8, label: '8 connections' },
    { value: 16, label: '16 connections' },
    { value: 24, label: '24 connections' },
    { value: 32, label: '32 connections' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 p-3 bg-blue-500/10 border border-blue-500/20 text-[var(--text-secondary)] rounded-lg text-xs">
        <AlertCircle className="w-5 h-5 text-[var(--accent-primary)] shrink-0" />
        <p className="leading-relaxed">
          Enter one download link per line. NOVA will queue the links with the same advanced direct-download settings.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-[var(--text-secondary)]">Batch Download Links</label>
          <div className="flex gap-1.5">
            <Button onClick={() => setShowAdvanced(v => !v)} variant="ghost" icon={Sliders} size="sm">
              Advanced
            </Button>
            <Button onClick={handlePasteClipboard} variant="ghost" icon={Clipboard} size="sm">
              Paste
            </Button>
          </div>
        </div>
        <textarea
          rows={8}
          placeholder=""
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg p-3 text-xs font-mono transition-all focus:border-[var(--accent-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)] text-left"
          style={{ direction: 'ltr' }}
        />
      </div>

      {showAdvanced && (
        <div className="p-3 bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded-lg space-y-3 animate-in fade-in slide-in-from-top-2 duration-150">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <SelectField label="Queue" value={queueId} onChange={(e) => setQueueId(e.target.value)} options={queueOptions} />
            <SelectField label="Connections" value={connections} onChange={(e) => setConnections(Number(e.target.value))} options={connectionOptions} />
            <TextField label="Save Directory" value={saveDirectory} onChange={(e) => setSaveDirectory(e.target.value)} className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <TextField label="Referer" value={referer} onChange={(e) => setReferer(e.target.value)} className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} />
            <TextField label="User-Agent" value={userAgent} onChange={(e) => setUserAgent(e.target.value)} className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} />
            <TextField label="Proxy" value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="http://127.0.0.1:8080" className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} />
            <div className="grid grid-cols-2 gap-3">
              <TextField label="Retries" type="number" value={retryCount} onChange={(e) => setRetryCount(Number(e.target.value))} />
              <TextField label="Timeout (s)" type="number" value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))} />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <textarea rows={3} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="Header-Name: value" className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]" style={{ direction: 'ltr' }} />
            <textarea rows={3} value={cookies} onChange={(e) => setCookies(e.target.value)} placeholder="name=value; other=value" className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]" style={{ direction: 'ltr' }} />
          </div>
          <textarea rows={3} value={rawOptions} onChange={(e) => setRawOptions(e.target.value)} placeholder="option-name=value" className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]" style={{ direction: 'ltr' }} />
        </div>
      )}

      <div className="flex justify-end gap-2 pt-4 border-t border-[var(--border-color)]">
        <DialogButton onClick={handleImport} variant="primary" icon={Layers}>
          Import & Queue
        </DialogButton>
        <DialogButton onClick={closeDialog} variant="ghost">
          {t('btn_cancel')}
        </DialogButton>
      </div>
    </div>
  );
};
