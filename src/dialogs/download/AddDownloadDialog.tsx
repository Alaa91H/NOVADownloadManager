/* src/dialogs/download/AddDownloadDialog.tsx */
import React, { useState, useEffect, useRef } from 'react';
import { Globe, FolderOpen, Sliders, Calendar, Youtube, ArrowRight, Magnet, FileDown } from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { tauriClient } from '../../api/tauriClient';
import { novaClient } from '../../api/novaClient';
import { FileType } from '../../types/desktop-ui.types';
import { detectUrlType } from '../../utils/urlDetector';
import { clearClipboardIfTextMatches, readClipboardText } from '../../utils/clipboard';
import { formatBytes } from '../../initialData';
import { 
  TextField, 
  SelectField, 
  Switch, 
  Checkbox, 
  FormRow, 
  DialogButton,
  Button 
} from '../../components/primitives';

export const AddDownloadDialog: React.FC = () => {
  const { dialog, closeDialog, queues, settings, addTask, addToast, openDialog, t } = useAppStore();

  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileType, setFileType] = useState<FileType>('other');
  const [sizeBytes, setSizeBytes] = useState(0);
  const [savePath, setSavePath] = useState(settings?.saveAndCategories?.defaultFolder || '');
  const [category, setCategory] = useState<FileType>('other');
  const [queueId, setQueueId] = useState('main');
  const [description, setDescription] = useState('');
  const [connections, setConnections] = useState<number>(0);
  const [resumable, setResumable] = useState(true);
  const [referer, setReferer] = useState('');
  const [userAgent, setUserAgent] = useState(settings?.extra?.userAgent || '');
  const [headers, setHeaders] = useState('');
  const [cookies, setCookies] = useState('');
  const [proxy, setProxy] = useState(() => {
    if (!settings?.connection?.enableProxy || !settings.connection.proxyHost) return '';
    const port = settings.connection.proxyPort ? `:${settings.connection.proxyPort}` : '';
    return `http://${settings.connection.proxyHost}${port}`;
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [checksum, setChecksum] = useState('');
  const [speedLimitKbs, setSpeedLimitKbs] = useState<number>(settings?.connection?.speedLimiter?.enabled ? settings.connection.speedLimiter.maxSpeedKbs : 0);
  const [retryCount, setRetryCount] = useState<number>(3);
  const [retryDelaySec, setRetryDelaySec] = useState<number>(5);
  const [timeoutSec, setTimeoutSec] = useState<number>(60);
  const [connectTimeoutSec, setConnectTimeoutSec] = useState<number>(30);
  const [minSplitSize, setMinSplitSize] = useState('1M');
  const [fileAllocation, setFileAllocation] = useState<'none' | 'prealloc' | 'falloc' | 'trunc'>('prealloc');
  const [allowOverwrite, setAllowOverwrite] = useState(false);
  const [autoFileRenaming, setAutoFileRenaming] = useState(false);
  const [conditionalGet, setConditionalGet] = useState(false);
  const [remoteTime, setRemoteTime] = useState(true);
  const [contentDisposition, setContentDisposition] = useState(true);
  const [parameterizedUri, setParameterizedUri] = useState(false);
  const [rawOptions, setRawOptions] = useState('');
  
  const [isFetchingInfo, setIsFetchingInfo] = useState(false);
  const [infoFetched, setInfoFetched] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [detectedUrlType, setDetectedUrlType] = useState<'media' | 'download' | 'unknown'>('unknown');
  const [torrentFile, setTorrentFile] = useState<File | null>(null);
  const latestUrlRef = useRef('');
  const torrentInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    latestUrlRef.current = url;
  }, [url]);

  useEffect(() => {
    return () => {
      if (settings?.extra?.preventClipboardHistory) {
        void clearClipboardIfTextMatches(latestUrlRef.current);
      }
    };
  }, [settings?.extra?.preventClipboardHistory]);

  const inferTypeFromName = (name: string): FileType => {
    const ext = name.split('?')[0].split('.').pop()?.toLowerCase() || '';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'iso', 'cab'].includes(ext)) return 'compressed';
    if (['exe', 'msi', 'apk', 'dmg', 'pkg', 'bat', 'sh'].includes(ext)) return 'program';
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub'].includes(ext)) return 'document';
    if (['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'ts'].includes(ext)) return 'video';
    if (['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma'].includes(ext)) return 'audio';
    return 'other';
  };

  const fileNameFromUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      const candidate = decodeURIComponent(parsed.pathname.substring(parsed.pathname.lastIndexOf('/') + 1));
      return candidate || 'download';
    } catch {
      return '';
    }
  };

  const buildSavePath = (type: FileType, name: string) => {
    const folder = settings?.saveAndCategories?.categoryFolders?.[type] || settings?.saveAndCategories?.defaultFolder || '';
    if (!folder || !name) return folder;
    return `${folder.replace(/[\\/]+$/, '')}\\${name}`;
  };

  // Read URL from drag-and-drop payload if provided, adjusting state during
  // render (the sentinel ensures the first render also picks up the payload).
  const [prevPayload, setPrevPayload] = useState<unknown>(Symbol('unset'));
  if (prevPayload !== dialog.payload) {
    setPrevPayload(dialog.payload);
    if (dialog.payload) {
      if (typeof dialog.payload === 'string') {
        setUrl(dialog.payload);
      } else if (typeof dialog.payload === 'object') {
        if (dialog.payload.url) {
          setUrl(dialog.payload.url);
        }
        if (dialog.payload.referer) {
          setReferer(dialog.payload.referer);
        }
      }
    }
  }

  // Detect the URL type and reset the derived fields whenever the URL
  // changes, adjusting state during render instead of in the probe effect.
  const [prevUrl, setPrevUrl] = useState<string | null>(null);
  if (prevUrl !== url) {
    setPrevUrl(url);
    setDetectedUrlType(detectUrlType(url));
    if (!url) {
      setFileName('');
      setCategory('other');
      setFileType('other');
      setSizeBytes(0);
      setInfoFetched(false);
      setIsFetchingInfo(false);
    } else {
      setIsFetchingInfo(true);
    }
  }

  // Auto-fill filename, category and detect URL type from the real HTTP endpoint when possible.
  useEffect(() => {
    if (!url) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        new URL(url);
        const probed = await novaClient.probeDownload(url);
        if (cancelled) return;
        const detectedName = probed.fileName || fileNameFromUrl(url) || 'download';
        const detectedType = probed.fileType || inferTypeFromName(detectedName);
        setFileName(detectedName);
        setFileType(detectedType);
        setCategory(detectedType);
        setSizeBytes(probed.sizeBytes || 0);
        setResumable(probed.resumable);
        setSavePath(buildSavePath(detectedType, detectedName));
        setInfoFetched(true);
      } catch (e) {
        if (cancelled) return;
        const detectedName = fileNameFromUrl(url);
        const detectedType = detectedName ? inferTypeFromName(detectedName) : 'other';
        setFileName(detectedName);
        setFileType(detectedType);
        setCategory(detectedType);
        setSizeBytes(0);
        setResumable(false);
        setSavePath(buildSavePath(detectedType, detectedName));
        setInfoFetched(!!detectedName);
      } finally {
        if (!cancelled) {
          setIsFetchingInfo(false);
        }
      }
    }, 700);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [url, settings?.saveAndCategories]);

  // Auto-redirect to YoutubeDownloadDialog when a media URL is detected
  useEffect(() => {
    if (detectedUrlType === 'media' && url.trim().startsWith('http')) {
      const mediaUrl = url.trim();
      const timer = setTimeout(() => {
        setUrl('');
        openDialog('youtubeDownload', mediaUrl);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [detectedUrlType, url, openDialog]);

  const clearSensitiveDialogState = () => {
    setUrl('');
    setDetectedUrlType('unknown');
    setFileName('');
    setFileType('other');
    setCategory('other');
    setSizeBytes(0);
    setInfoFetched(false);
    setIsFetchingInfo(false);
  };

  const cleanupSensitiveLink = (value: string) => {
    if (settings?.extra?.preventClipboardHistory) {
      void clearClipboardIfTextMatches(value);
    }
  };

  const closeWithoutKeepingLink = () => {
    const currentUrl = latestUrlRef.current;
    clearSensitiveDialogState();
    cleanupSensitiveLink(currentUrl);
    closeDialog();
  };

  const handlePickDirectory = async () => {
    const defaultDir = savePath ? savePath.substring(0, savePath.lastIndexOf('\\')) : undefined;
    const picked = await tauriClient.showDirectoryPicker(defaultDir);
    if (picked) {
      setSavePath(`${picked}\\${fileName || 'download'}`);
    } else {
      addToast('info', 'Directory picker unavailable', 'Type the destination path manually.');
    }
  };

  const handleTorrentFilePick = () => {
    torrentInputRef.current?.click();
  };

  const handleTorrentFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setTorrentFile(file);
      setFileName(file.name.replace(/\.torrent$/i, '') || 'torrent');
      setFileType('other');
    }
  };

  const handleSubmit = async (downloadImmediately: boolean) => {
    const submittedUrl = url.trim();

    // Torrent file upload
    if (torrentFile) {
      const buf = await torrentFile.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      try {
        await novaClient.addTorrent({
          torrentBase64: base64,
          name: fileName || torrentFile.name.replace(/\.torrent$/i, ''),
          savePath: savePath || undefined
        });
        clearSensitiveDialogState();
        closeDialog();
      } catch (error) {
        addToast('error', 'Torrent Error', error instanceof Error ? error.message : 'Failed to add torrent.');
      }
      return;
    }

    if (!submittedUrl || !fileName) {
      addToast('error', 'Download Error', 'Please enter a valid download link.');
      return;
    }

    // Magnet link – route through torrent endpoint.
    if (submittedUrl.startsWith('magnet:')) {
      try {
        await novaClient.addTorrent({
          magnet: submittedUrl,
          name: fileName,
          savePath: savePath || undefined
        });
        clearSensitiveDialogState();
        cleanupSensitiveLink(submittedUrl);
        closeDialog();
      } catch (error) {
        addToast('error', 'Torrent Error', error instanceof Error ? error.message : 'Failed to add magnet link.');
      }
      return;
    }

    const urlType = detectUrlType(submittedUrl);
    if (urlType === 'media') {
      clearSensitiveDialogState();
      openDialog('youtubeDownload', submittedUrl);
      return;
    }

    const task = await addTask({
      name: fileName,
      url: submittedUrl,
      fileType,
      status: downloadImmediately ? 'downloading' : 'queued',
      sizeBytes,
      category,
      queueId,
      connections,
      resumable,
      savePath,
      description,
      referer,
      directOptions: {
        userAgent: userAgent.trim() || undefined,
        referer: referer.trim() || undefined,
        headers: headers.trim() || undefined,
        cookies: cookies.trim() || undefined,
        proxy: proxy.trim() || undefined,
        username: username.trim() || undefined,
        password: password.trim() || undefined,
        checksum: checksum.trim() || undefined,
        speedLimitKbs: speedLimitKbs > 0 ? speedLimitKbs : undefined,
        retryCount: retryCount > 0 ? retryCount : undefined,
        retryDelaySec: retryDelaySec >= 0 ? retryDelaySec : undefined,
        timeoutSec: timeoutSec > 0 ? timeoutSec : undefined,
        connectTimeoutSec: connectTimeoutSec > 0 ? connectTimeoutSec : undefined,
        minSplitSize: minSplitSize.trim() || undefined,
        fileAllocation,
        allowOverwrite,
        autoFileRenaming,
        conditionalGet,
        remoteTime,
        contentDisposition,
        parameterizedUri,
        rawOptions: rawOptions.trim() || undefined,
      },
    }, downloadImmediately);

    if (task) {
      clearSensitiveDialogState();
      cleanupSensitiveLink(submittedUrl);
      closeDialog();
    }
  };

  const queueOptions = queues.map(q => ({ value: q.id, label: q.name }));
  const connectionOptions = [
    { value: 0, label: 'Automatic (Default)' },
    { value: 8, label: '8 threads' },
    { value: 16, label: '16 threads' },
    { value: 24, label: '24 threads' },
    { value: 32, label: '32 threads (Max Speed)' }
  ];

  const categoryOptions = [
    { value: 'document', label: t('documents') },
    { value: 'program', label: t('programs') },
    { value: 'compressed', label: t('compressed') },
    { value: 'video', label: t('videos') },
    { value: 'audio', label: t('audio') },
    { value: 'other', label: t('others') }
  ];

  return (
    <div className="space-y-4">
      {/* 1. Direct URL Input Row with Paste icon on far right */}
      <div className="space-y-1.5">
        <div className="relative">
          <input
            type="text"
            placeholder=""
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded text-[11px] font-mono transition-all focus:border-[var(--accent-primary)] focus:outline-none py-1.5 px-2.5 pr-16 text-left text-[var(--text-primary)]"
            style={{ direction: 'ltr' }}
            autoFocus
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <button
              onClick={handleTorrentFilePick}
              className="text-[var(--text-muted)] hover:text-[var(--accent-primary)] transition-colors p-1"
              title={t('add_dl_torrent_file') || 'Browse torrent file'}
            >
              <Magnet className="w-4 h-4" />
            </button>
            <button 
              onClick={async () => {
                try {
                  const text = await readClipboardText();
                  if (text) setUrl(text);
                } catch (e) {
                  addToast('error', 'Clipboard unavailable', 'NOVA could not read a URL from the clipboard.');
                }
              }}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors p-1"
              title="Paste from clipboard"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                <rect x="8" y="2" width="8" height="4" rx="1" ry="1" fill="none" className="stroke-[var(--border-color)]" />
              </svg>
            </button>
          </div>
          {isFetchingInfo && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center">
              <span className="w-4 h-4 rounded-full border-2 border-[var(--accent-primary)] border-t-transparent animate-spin" />
            </div>
          )}
        </div>
      </div>

      {/* Torrent file name indicator */}
      {torrentFile && (
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--accent-primary)]">
          <Magnet className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{torrentFile.name}</span>
          <button
            onClick={() => setTorrentFile(null)}
            className="ml-auto text-[10px] text-[var(--text-muted)] hover:text-red-400 transition-colors cursor-pointer shrink-0"
          >
            Clear
          </button>
        </div>
      )}
      {url.startsWith('magnet:') && (
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]" style={{ direction: 'ltr' }}>
          <Magnet className="w-3.5 h-3.5 shrink-0" />
          <span>Magnet link detected</span>
        </div>
      )}

      {/* Media URL Detection Banner */}
      {detectedUrlType === 'media' && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs">
            <Youtube className="w-4 h-4 text-red-500 shrink-0" />
            <span className="text-slate-300">
              This is a media URL. Use the Media Downloader for quality & format options.
            </span>
          </div>
          <button
            onClick={() => {
              const mediaUrl = url.trim();
              setUrl('');
              openDialog('youtubeDownload', mediaUrl);
            }}
            className="shrink-0 px-3 py-1 text-[10px] font-bold bg-red-600 hover:bg-red-500 text-white rounded transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <Youtube className="w-3 h-3" />
            <span>Open Media Downloader</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      )}

      <input
        type="file"
        ref={torrentInputRef}
        accept=".torrent"
        style={{ display: 'none' }}
        onChange={handleTorrentFileChange}
      />

      {/* 2. Destination Folder & File Size Row */}
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)] font-semibold">
          <svg className="w-3.5 h-3.5 text-[var(--accent-primary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span className="truncate font-mono" style={{ direction: 'ltr' }}>
            {savePath ? savePath.substring(0, Math.max(0, savePath.lastIndexOf('\\'))) || savePath : 'Default folder'}
          </span>
        </div>
        <div className="grid grid-cols-[1fr_110px] gap-3 items-center">
          <div className="relative">
            <input 
              type="text" 
              value={savePath} 
              onChange={(e) => setSavePath(e.target.value)}
              className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded text-[11px] py-1.5 pr-10 pl-2.5 focus:outline-none font-mono text-left text-[var(--text-primary)]"
              style={{ direction: 'ltr' }}
            />
            <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center text-[var(--text-muted)]">
              <button onClick={handlePickDirectory} className="hover:text-[var(--text-primary)] transition-colors cursor-pointer" title="Browse folders">
                <svg className="w-4 h-4 text-[var(--text-secondary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            </div>
          </div>

        {/* Size display with dynamic state border and no checkmark/text */}
        {(() => {
          let borderColor = "border-[var(--border-color)] bg-[var(--bg-hover)]/30 text-[var(--text-muted)]";
          let textColor = "text-[var(--text-secondary)]";

          if (isFetchingInfo) {
            borderColor = "border-amber-500 bg-amber-500/5 text-amber-500 animate-pulse";
            textColor = "text-amber-500";
          } else if (infoFetched) {
            if (sizeBytes && sizeBytes > 0) {
              borderColor = "border-emerald-500 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400";
              textColor = "text-emerald-600 dark:text-emerald-400";
            } else {
              borderColor = "border-[var(--border-color)] bg-[var(--bg-hover)]/30 text-[var(--text-secondary)]";
              textColor = "text-[var(--text-secondary)]";
            }
          }

          return (
            <div className={`flex items-center justify-center shrink-0 select-none text-center h-[26px] px-2.5 rounded-full border ${borderColor} transition-all duration-300`} title={isFetchingInfo ? "Calculating size..." : "File size"}>
              <span className={`text-[10px] font-mono font-bold leading-none ${textColor}`}>
                {formatBytes(sizeBytes || 0)}
              </span>
            </div>
          );
          })()}
        </div>
      </div>

      {/* 3. Filename & Action Buttons Row */}
      <div className="grid grid-cols-[1fr_90px] gap-3 items-center">
        <input
          type="text"
          placeholder={t('add_dl_filename')}
          value={fileName}
          onChange={(e) => setFileName(e.target.value)}
          className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded text-[11px] font-mono transition-all focus:border-[var(--accent-primary)] focus:outline-none py-1.5 px-2.5 text-left text-[var(--text-primary)]"
          style={{ direction: 'ltr' }}
        />

        {/* Small rounded action buttons */}
        <div className="flex gap-2 shrink-0">
          {/* Refresh Button */}
          <button 
            onClick={() => {
              if (url) {
                const detectedName = fileNameFromUrl(url);
                setFileName(detectedName);
                setSavePath(buildSavePath(inferTypeFromName(detectedName), detectedName));
              }
            }}
            className="w-7.5 h-7.5 flex items-center justify-center bg-[var(--bg-input)] border border-[var(--border-color)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors cursor-pointer"
            title="Update Name"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          </button>

          {/* Toggle Advanced Settings Gear Button */}
          <button 
            onClick={() => setShowAdvanced(!showAdvanced)}
            className={`w-7.5 h-7.5 flex items-center justify-center border hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-all cursor-pointer ${
              showAdvanced ? 'bg-[var(--accent-light)] border-[var(--accent-primary)] text-[var(--accent-primary)]' : 'bg-[var(--bg-input)] border-[var(--border-color)]'
            }`}
            title="Advanced Options"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>

      {/* 4. Expandable Advanced Controls Section */}
      {showAdvanced && (
        <div className="p-2.5 bg-[var(--bg-sidebar)] border border-[var(--border-color)] rounded space-y-2.5 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <SelectField 
              label={t('add_dl_category')} 
              value={category} 
              onChange={(e) => {
                const newCat = e.target.value as FileType;
                setCategory(newCat);
                setFileType(newCat);
                const configuredFolder = settings?.saveAndCategories?.categoryFolders?.[newCat] || settings?.saveAndCategories?.defaultFolder || '';
                setSavePath(`${configuredFolder}\\${fileName || 'file_download.bin'}`);
              }} 
              options={categoryOptions} 
            />
            <SelectField 
              label={t('add_dl_queue')} 
              value={queueId} 
              onChange={(e) => setQueueId(e.target.value)} 
              options={queueOptions} 
            />
            <SelectField 
              label={t('add_dl_threads')} 
              value={connections} 
              onChange={(e) => setConnections(Number(e.target.value))} 
              options={connectionOptions} 
            />
          </div>

          <TextField 
            label={t('add_dl_desc')} 
            value={description} 
            onChange={(e) => setDescription(e.target.value)} 
            placeholder="Enter notes or description for this file..."
          />

          <div className="flex items-center gap-6 pt-2">
            <Checkbox 
              label={t('add_dl_resumable')} 
              checked={resumable} 
              onChange={setResumable} 
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-[var(--border-color)]/40">
            <TextField
              label="Referer"
              value={referer}
              onChange={(e) => setReferer(e.target.value)}
              placeholder="https://example.com/page"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="User-Agent"
              value={userAgent}
              onChange={(e) => setUserAgent(e.target.value)}
              placeholder="Mozilla/5.0 ..."
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Proxy"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
              placeholder="http://127.0.0.1:8080"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Checksum"
              value={checksum}
              onChange={(e) => setChecksum(e.target.value)}
              placeholder="sha-256=..."
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <TextField
              label="Speed Limit (KB/s)"
              type="number"
              value={speedLimitKbs}
              onChange={(e) => setSpeedLimitKbs(Number(e.target.value))}
            />
            <TextField
              label="Retries"
              type="number"
              value={retryCount}
              onChange={(e) => setRetryCount(Number(e.target.value))}
            />
            <TextField
              label="Retry Delay (s)"
              type="number"
              value={retryDelaySec}
              onChange={(e) => setRetryDelaySec(Number(e.target.value))}
            />
            <TextField
              label="Timeout (s)"
              type="number"
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(Number(e.target.value))}
            />
            <TextField
              label="Connect Timeout (s)"
              type="number"
              value={connectTimeoutSec}
              onChange={(e) => setConnectTimeoutSec(Number(e.target.value))}
            />
            <TextField
              label="Minimum Split Size"
              value={minSplitSize}
              onChange={(e) => setMinSplitSize(e.target.value)}
              placeholder="1M"
            />
            <SelectField
              label="File Allocation"
              value={fileAllocation}
              onChange={(e) => setFileAllocation(e.target.value as 'none' | 'prealloc' | 'falloc' | 'trunc')}
              options={[
                { value: 'none', label: 'None' },
                { value: 'prealloc', label: 'Pre-allocate' },
                { value: 'falloc', label: 'Fast allocation' },
                { value: 'trunc', label: 'Truncate' },
              ]}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
            <Checkbox label="Allow overwrite" checked={allowOverwrite} onChange={setAllowOverwrite} />
            <Checkbox label="Auto-rename duplicates" checked={autoFileRenaming} onChange={setAutoFileRenaming} />
            <Checkbox label="Conditional download" checked={conditionalGet} onChange={setConditionalGet} />
            <Checkbox label="Preserve remote file time" checked={remoteTime} onChange={setRemoteTime} />
            <Checkbox label="Use server filename when available" checked={contentDisposition} onChange={setContentDisposition} />
            <Checkbox label="Expand parameterized URLs" checked={parameterizedUri} onChange={setParameterizedUri} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">Custom Headers</label>
              <textarea
                rows={3}
                value={headers}
                onChange={(e) => setHeaders(e.target.value)}
                placeholder="Header-Name: value"
                className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
                style={{ direction: 'ltr' }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">Cookies</label>
              <textarea
                rows={3}
                value={cookies}
                onChange={(e) => setCookies(e.target.value)}
                placeholder="name=value; other=value"
                className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
                style={{ direction: 'ltr' }}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">Expert Engine Options</label>
            <textarea
              rows={3}
              value={rawOptions}
              onChange={(e) => setRawOptions(e.target.value)}
              placeholder="option-name=value"
              className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
              style={{ direction: 'ltr' }}
            />
          </div>
        </div>
      )}

      {/* 5. Footer Buttons Bar */}
      <div className="flex justify-between items-center pt-3 mt-2.5 border-t border-[var(--border-color)]">
        {/* Left Side Buttons: Add, Download */}
        <div className="flex gap-2">
          <button 
            onClick={() => handleSubmit(false)} 
            className="px-3 py-1.5 text-[11px] font-bold bg-[var(--bg-input)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-all cursor-pointer"
            disabled={!url || isFetchingInfo}
          >
            {t('add_dl_queue_only')}
          </button>
          
          <button 
            onClick={() => handleSubmit(true)} 
            className="px-4 py-1.5 text-[11px] font-bold bg-[var(--accent-primary)] hover:opacity-95 text-white rounded transition-all cursor-pointer shadow-sm"
            disabled={!url || isFetchingInfo}
          >
            {t('add_dl_start_now')}
          </button>
        </div>

        {/* Right Side Button: Cancel */}
        <button 
          onClick={closeWithoutKeepingLink} 
          className="px-3 py-1.5 text-[11px] font-bold text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-all cursor-pointer"
        >
          {t('add_dl_cancel')}
        </button>
      </div>
    </div>
  );
};
