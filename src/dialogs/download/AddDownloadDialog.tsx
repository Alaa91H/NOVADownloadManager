/* src/dialogs/download/AddDownloadDialog.tsx */
import React, { useCallback, useState, useEffect, useRef } from 'react';
import { Video, ArrowRight, RefreshCw } from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { tauriClient } from '../../api/tauriClient';
import { novaClient } from '../../api/novaClient';
import { FileType } from '../../types/desktop-ui.types';
import { detectUrlType } from '../../utils/urlDetector';
import { clearClipboardIfTextMatches, readClipboardText } from '../../utils/clipboard';
import { formatBytes } from '../../initialData';
import { TextField, SelectField, Checkbox } from '../../components/primitives';
import { DegradedBanner } from '../../components/primitives/DegradedBanner';
import { useEngineCapabilities } from '../../capabilities/EngineCapabilityContext';

export const AddDownloadDialog: React.FC = () => {
  const { dialog, closeDialog, queues, settings, addTask, addToast, openDialog, t, isDegradedMode } = useAppStore();
  const engineCapabilities = useEngineCapabilities();

  const buildConfiguredProxy = () => {
    const vpnProxy =
      settings.extra.vpnEnabled && settings.extra.vpnMode === 'proxy' ? settings.extra.vpnProxyUrl.trim() : '';
    if (vpnProxy) return vpnProxy;
    if (!settings.connection.enableProxy || !settings.connection.proxyHost) return '';
    const port = settings.connection.proxyPort ? `:${settings.connection.proxyPort}` : '';
    return `http://${settings.connection.proxyHost}${port}`;
  };

  const configuredSourceAddress =
    settings.extra.vpnEnabled && settings.extra.vpnMode === 'bind' ? settings.extra.vpnBindAddress.trim() : '';

  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileType, setFileType] = useState<FileType>('other');
  const [sizeBytes, setSizeBytes] = useState(0);
  const [probeError, setProbeError] = useState('');
  const [savePath, setSavePath] = useState(settings.saveAndCategories.defaultFolder || '');
  // OS Downloads folder used when no default folder is configured, so the
  // path box always shows where the file will actually land.
  const [defaultDownloadsDir, setDefaultDownloadsDir] = useState('');
  const [category, setCategory] = useState<FileType>('other');
  const [queueId, setQueueId] = useState('main');
  const [description, setDescription] = useState('');
  const [connections, setConnections] = useState<number>(settings.connection.maxConnections);
  const [resumable, setResumable] = useState(true);
  const [referer, setReferer] = useState('');
  const [userAgent, setUserAgent] = useState(settings.extra.userAgent || '');
  const [headers, setHeaders] = useState('');
  const [cookies, setCookies] = useState('');
  const [proxy, setProxy] = useState(buildConfiguredProxy);
  const [speedLimitKbs, setSpeedLimitKbs] = useState<number>(
    settings.connection.speedLimiter.enabled ? settings.connection.speedLimiter.maxSpeedKbs : 0,
  );
  const [retryCount, setRetryCount] = useState<number>(3);
  const [retryDelaySec, setRetryDelaySec] = useState<number>(5);
  const [timeoutSec, setTimeoutSec] = useState<number>(60);
  const [connectTimeoutSec, setConnectTimeoutSec] = useState<number>(30);
  const [allowOverwrite, setAllowOverwrite] = useState(settings.extra.duplicateAction === 'overwrite');
  const [isFetchingInfo, setIsFetchingInfo] = useState(false);
  const [infoFetched, setInfoFetched] = useState(false);
  const [probeNonce, setProbeNonce] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [detectedUrlType, setDetectedUrlType] = useState<'media' | 'download' | 'unknown'>('unknown');
  const latestUrlRef = useRef('');

  useEffect(() => {
    latestUrlRef.current = url;
  }, [url]);

  const directEngineReady = engineCapabilities.directReady;
  const supportedDirectOptions = engineCapabilities.directOptionKeys;

  const isDirectOptionSupported = useCallback(
    (key: string) => engineCapabilities.supportsDirectOption(key),
    [engineCapabilities],
  );

  const supportsSegmentedDownloads = isDirectOptionSupported('segmented') && isDirectOptionSupported('range');

  // Derive the effective connection count instead of clamping via an effect:
  // segmentation-less engines always use a single connection.
  const effectiveConnections = supportsSegmentedDownloads ? connections : 1;

  useEffect(() => {
    return () => {
      if (settings.extra.preventClipboardHistory) {
        void clearClipboardIfTextMatches(latestUrlRef.current);
      }
    };
  }, [settings.extra.preventClipboardHistory]);

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

  useEffect(() => {
    let cancelled = false;
    void tauriClient
      .getDownloadsDir()
      .then((dir) => {
        if (cancelled || !dir) return;
        setDefaultDownloadsDir(dir);
        setSavePath((prev) => prev || dir);
      })
      .catch(() => {
        /* native directory unavailable — user can type path manually */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const buildSavePath = useCallback(
    (type: FileType, name: string) => {
      const folder =
        settings.saveAndCategories.categoryFolders[type] ||
        settings.saveAndCategories.defaultFolder ||
        defaultDownloadsDir ||
        '';
      if (!folder || !name) return folder || name;
      return `${folder.replace(/[\\/]+$/, '')}\\${name}`;
    },
    [settings, defaultDownloadsDir],
  );

  // Read URL from drag-and-drop payload if provided, adjusting state during
  // render (the sentinel ensures the first render also picks up the payload).
  const [prevPayload, setPrevPayload] = useState<unknown>(Symbol('unset'));
  if (prevPayload !== dialog.payload) {
    setPrevPayload(dialog.payload);
    if (dialog.payload) {
      if (typeof dialog.payload === 'string') {
        setUrl(dialog.payload);
      } else if (typeof dialog.payload === 'object') {
        const payload = dialog.payload as { url?: string; referer?: string };
        if (payload.url) {
          setUrl(payload.url);
        }
        if (payload.referer) {
          setReferer(payload.referer);
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
    setProbeError('');
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
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          new URL(url);
          const probed = await novaClient.probeDownload(url, {
            referer: referer.trim() || undefined,
            directOptions: {
              userAgent: isDirectOptionSupported('userAgent') ? userAgent.trim() || undefined : undefined,
              referer: isDirectOptionSupported('referer') ? referer.trim() || undefined : undefined,
              headers: isDirectOptionSupported('headers') ? headers.trim() || undefined : undefined,
              cookies: isDirectOptionSupported('cookies') ? cookies.trim() || undefined : undefined,
              proxy: isDirectOptionSupported('proxy') ? proxy.trim() || undefined : undefined,
              sourceAddress: isDirectOptionSupported('sourceAddress')
                ? configuredSourceAddress || undefined
                : undefined,
            },
          });
          if (cancelled) return;
          const detectedName = probed.fileName;
          const detectedType = probed.fileType;
          setFileName(detectedName);
          setFileType(detectedType);
          setCategory(detectedType);
          const probedSize = Number.isFinite(probed.sizeBytes) && probed.sizeBytes > 0 ? probed.sizeBytes : 0;
          setSizeBytes(probedSize);
          setProbeError(probedSize > 0 ? '' : 'The server did not report a file size.');
          setResumable(probed.resumable);
          if (probed.supportsSegments === false) setConnections(1);
          setSavePath(buildSavePath(detectedType, detectedName));
          setInfoFetched(true);
        } catch (error) {
          if (cancelled) return;
          const detectedName = fileNameFromUrl(url);
          const detectedType = detectedName ? inferTypeFromName(detectedName) : 'other';
          const message =
            error instanceof Error && error.name === 'AbortError'
              ? 'File size probe timed out. Retry after the server responds.'
              : error instanceof Error && error.message
                ? error.message
                : 'File size unavailable for this link.';
          setFileName(detectedName);
          setFileType(detectedType);
          setCategory(detectedType);
          setSizeBytes(0);
          setProbeError(message);
          setResumable(false);
          setSavePath(buildSavePath(detectedType, detectedName));
          setInfoFetched(!!detectedName);
        } finally {
          if (!cancelled) {
            setIsFetchingInfo(false);
          }
        }
      })();
    }, 700);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    url,
    referer,
    userAgent,
    headers,
    cookies,
    proxy,
    configuredSourceAddress,
    settings.saveAndCategories,
    defaultDownloadsDir,
    buildSavePath,
    isDirectOptionSupported,
    probeNonce,
  ]);

  // Auto-redirect to YoutubeDownloadDialog when a media URL is detected
  useEffect(() => {
    if (detectedUrlType === 'media' && url.trim().startsWith('http')) {
      const mediaUrl = url.trim();
      const timer = setTimeout(() => {
        setUrl('');
        openDialog('youtubeDownload', mediaUrl);
      }, 400);
      return () => {
        clearTimeout(timer);
      };
    }
  }, [detectedUrlType, url, openDialog]);

  const clearSensitiveDialogState = () => {
    setUrl('');
    setDetectedUrlType('unknown');
    setFileName('');
    setFileType('other');
    setCategory('other');
    setSizeBytes(0);
    setProbeError('');
    setInfoFetched(false);
    setIsFetchingInfo(false);
  };

  const cleanupSensitiveLink = (value: string) => {
    if (settings.extra.preventClipboardHistory) {
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
      addToast('info', t('add_dl_dir_picker_unavail'), t('add_dl_dir_picker_desc'));
    }
  };

  const handleSubmit = async (downloadImmediately: boolean) => {
    const submittedUrl = url.trim();

    const directBlock = engineCapabilities.directBlockedReason(submittedUrl);
    if (directBlock) {
      addToast('error', t('add_dl_direct_unavail'), directBlock);
      return;
    }

    if (
      settings.extra.vpnEnabled &&
      settings.extra.vpnKillSwitch &&
      ((settings.extra.vpnMode === 'proxy' && !settings.extra.vpnProxyUrl.trim()) ||
        (settings.extra.vpnMode === 'bind' && !settings.extra.vpnBindAddress.trim()))
    ) {
      addToast('error', t('add_dl_vpn_routing'), t('add_dl_vpn_incomplete'));
      return;
    }

    const vpnRoute = await tauriClient.validateVpnRoute(settings);
    if (!vpnRoute.ok) {
      addToast('error', t('add_dl_vpn_routing'), vpnRoute.message);
      return;
    }

    if (!submittedUrl || !fileName) {
      addToast('error', t('add_dl_err_title'), t('add_dl_valid_link'));
      return;
    }

    if (submittedUrl.startsWith('magnet:') || submittedUrl.toLowerCase().endsWith('.torrent')) {
      addToast('error', t('add_dl_unsupported'), t('add_dl_unsupported_desc'));
      return;
    }

    const urlType = detectUrlType(submittedUrl);
    if (urlType === 'media') {
      clearSensitiveDialogState();
      openDialog('youtubeDownload', submittedUrl);
      return;
    }

    const directOptions = engineCapabilities.sanitizeDirectOptions({
      userAgent: userAgent.trim() || undefined,
      referer: referer.trim() || undefined,
      headers: headers.trim() || undefined,
      cookies: cookies.trim() || undefined,
      proxy: proxy.trim() || undefined,
      sourceAddress: configuredSourceAddress || undefined,
      speedLimitKbs: speedLimitKbs > 0 ? speedLimitKbs : undefined,
      retryCount: retryCount > 0 ? retryCount : undefined,
      retryDelaySec: retryDelaySec > 0 ? retryDelaySec : undefined,
      timeoutSec: timeoutSec > 0 ? timeoutSec : undefined,
      connectTimeoutSec: connectTimeoutSec > 0 ? connectTimeoutSec : undefined,
      allowOverwrite: allowOverwrite ? undefined : false,
      segmented: supportsSegmentedDownloads && effectiveConnections > 1 && resumable ? true : undefined,
    });

    const task = await addTask(
      {
        name: fileName,
        url: submittedUrl,
        fileType,
        status: downloadImmediately ? 'downloading' : 'queued',
        sizeBytes,
        category,
        queueId,
        connections: effectiveConnections,
        resumable,
        savePath,
        description,
        referer,
        directOptions,
      },
      downloadImmediately,
    );

    if (task) {
      clearSensitiveDialogState();
      cleanupSensitiveLink(submittedUrl);
      closeDialog();
    }
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

  const categoryOptions = [
    { value: 'document', label: t('documents') },
    { value: 'program', label: t('programs') },
    { value: 'compressed', label: t('compressed') },
    { value: 'video', label: t('videos') },
    { value: 'audio', label: t('audio') },
    { value: 'other', label: t('others') },
  ];

  const canSubmitDownload = Boolean(url.trim()) && !isFetchingInfo && directEngineReady;

  return (
    <div className="space-y-4">
      {isDegradedMode && (
        <DegradedBanner title={t('dialog_degraded_title')} description={t('dialog_degraded_desc')} />
      )}
      {!directEngineReady && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-200">
          {t('add_dl_direct_unavailable')}
        </div>
      )}
      {showAdvanced && supportedDirectOptions.size > 0 && (
        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-hover)]/30 p-2 text-[10px] text-[var(--text-secondary)]">
          {t('add_dl_advanced_gated')}
        </div>
      )}
      {/* 1. Direct URL Input Row with Paste icon on far right */}
      <div className="space-y-1.5">
        <div className="relative">
          <input
            type="text"
            placeholder=""
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
            }}
            className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded text-[11px] font-mono transition-all focus:border-[var(--accent-primary)] focus:outline-none py-1.5 px-2.5 pr-16 text-left text-[var(--text-primary)]"
            style={{ direction: 'ltr' }}
            autoFocus
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <button
              onClick={() => {
                void (async () => {
                  try {
                    const text = await readClipboardText();
                    if (text) setUrl(text);
                  } catch {
                    addToast('error', t('add_dl_clipboard_unavail'), t('add_dl_clipboard_desc'));
                  }
                })();
              }}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors p-1"
              title={t('add_dl_paste_clipboard')}
            >
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                <rect
                  x="8"
                  y="2"
                  width="8"
                  height="4"
                  rx="1"
                  ry="1"
                  fill="none"
                  className="stroke-[var(--border-color)]"
                />
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

      {/* Media URL Detection Banner */}
      {detectedUrlType === 'media' && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs">
            <Video className="w-4 h-4 text-red-500 shrink-0" />
            <span className="text-slate-300">
              {t('add_dl_media_banner')}
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
            <Video className="w-3 h-3" />
            <span>{t('add_dl_open_media_dl')}</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* 2. Destination Folder & File Size Row */}
      <div className="space-y-1">
        <div className="grid grid-cols-[1fr_110px] gap-3 items-center">
          <div className="relative">
            <input
              type="text"
              value={savePath}
              onChange={(e) => {
                setSavePath(e.target.value);
              }}
              className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded text-[11px] py-1.5 pr-10 pl-2.5 focus:outline-none font-mono text-left text-[var(--text-primary)]"
              style={{ direction: 'ltr' }}
            />
            <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center text-[var(--text-muted)]">
              <button
                onClick={() => {
                  void handlePickDirectory();
                }}
                className="hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                title={t('add_dl_browse_folders')}
              >
                <svg
                  className="w-4 h-4 text-[var(--text-secondary)]"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            </div>
          </div>

          {/* Size display with dynamic state border and no checkmark/text */}
          {(() => {
            let borderColor = 'border-[var(--border-color)] bg-[var(--bg-hover)]/30 text-[var(--text-muted)]';
            let textColor = 'text-[var(--text-secondary)]';
            const sizeKnown = sizeBytes > 0;
            const sizeLabel = isFetchingInfo ? t('add_dl_checking') : sizeKnown ? formatBytes(sizeBytes) : t('add_dl_unknown');
            const sizeTitle = isFetchingInfo
              ? t('add_dl_checking')
              : sizeKnown
                ? t('add_dl_file_size')
                : probeError || t('add_dl_file_size_unavail');

            if (isFetchingInfo) {
              borderColor = 'border-amber-500 bg-amber-500/5 text-amber-500 animate-pulse';
              textColor = 'text-amber-500';
            } else if (infoFetched) {
              if (sizeKnown) {
                borderColor = 'border-emerald-500 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400';
                textColor = 'text-emerald-600 dark:text-emerald-400';
              } else {
                borderColor = 'border-[var(--border-color)] bg-[var(--bg-hover)]/30 text-[var(--text-secondary)]';
                textColor = 'text-[var(--text-secondary)]';
              }
            }

            return (
              <div
                className={`flex min-w-[92px] items-center justify-center shrink-0 select-none text-center h-[26px] px-2.5 rounded-full border ${borderColor} transition-all duration-300`}
                title={sizeTitle}
              >
                <span className={`text-[10px] font-mono font-bold leading-none ${textColor}`}>{sizeLabel}</span>
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
          onChange={(e) => {
            setFileName(e.target.value);
          }}
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
                setInfoFetched(false);
                setProbeError('');
                setIsFetchingInfo(true);
                setProbeNonce((value) => value + 1);
              }
            }}
            className="w-7.5 h-7.5 flex items-center justify-center bg-[var(--bg-input)] border border-[var(--border-color)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors cursor-pointer"
            title={t('add_dl_refresh_info')}
          >
            <RefreshCw className="w-3.5 h-3.5" strokeWidth={2.5} />
          </button>

          {/* Toggle Advanced Settings Gear Button */}
          <button
            onClick={() => {
              setShowAdvanced(!showAdvanced);
            }}
            className={`w-7.5 h-7.5 flex items-center justify-center border hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-all cursor-pointer ${
              showAdvanced
                ? 'bg-[var(--accent-light)] border-[var(--accent-primary)] text-[var(--accent-primary)]'
                : 'bg-[var(--bg-input)] border-[var(--border-color)]'
            }`}
            title={t('add_dl_advanced_opts')}
          >
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
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
                const configuredFolder =
                  settings.saveAndCategories.categoryFolders[newCat] || settings.saveAndCategories.defaultFolder || '';
                setSavePath(`${configuredFolder}\\${fileName || 'file_download.bin'}`);
              }}
              options={categoryOptions}
            />
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
              value={effectiveConnections}
              onChange={(e) => {
                setConnections(Number(e.target.value));
              }}
              options={connectionOptions}
              disabled={!supportsSegmentedDownloads}
            />
          </div>

          <TextField
            label={t('add_dl_desc')}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
            placeholder={t('add_dl_notes_placeholder')}
          />

          <div className="flex items-center gap-6 pt-2">
            <Checkbox
              label={t('add_dl_resumable')}
              checked={resumable}
              onChange={setResumable}
              disabled={!isDirectOptionSupported('range')}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-[var(--border-color)]/40">
            <TextField
              label={t('add_dl_referer')}
              value={referer}
              onChange={(e) => {
                setReferer(e.target.value);
              }}
              placeholder="https://example.com/page"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
              disabled={!isDirectOptionSupported('referer')}
            />
            <TextField
              label={t('add_dl_user_agent')}
              value={userAgent}
              onChange={(e) => {
                setUserAgent(e.target.value);
              }}
              placeholder="Mozilla/5.0 ..."
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
              disabled={!isDirectOptionSupported('userAgent')}
            />
            <TextField
              label={t('add_dl_proxy')}
              value={proxy}
              onChange={(e) => {
                setProxy(e.target.value);
              }}
              placeholder="http://127.0.0.1:8080"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
              disabled={!isDirectOptionSupported('proxy')}
            />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <TextField
              label={t('add_dl_speed_limit')}
              type="number"
              value={speedLimitKbs}
              onChange={(e) => {
                setSpeedLimitKbs(Number(e.target.value));
              }}
              disabled={!isDirectOptionSupported('speedLimitKbs')}
            />
            <TextField
              label={t('add_dl_retries')}
              type="number"
              value={retryCount}
              onChange={(e) => {
                setRetryCount(Number(e.target.value));
              }}
              disabled={!isDirectOptionSupported('retryCount')}
            />
            <TextField
              label={t('add_dl_retry_delay')}
              type="number"
              value={retryDelaySec}
              onChange={(e) => {
                setRetryDelaySec(Number(e.target.value));
              }}
              disabled={!isDirectOptionSupported('retryDelaySec')}
            />
            <TextField
              label={t('add_dl_timeout')}
              type="number"
              value={timeoutSec}
              onChange={(e) => {
                setTimeoutSec(Number(e.target.value));
              }}
              disabled={!isDirectOptionSupported('timeoutSec')}
            />
            <TextField
              label={t('add_dl_connect_timeout')}
              type="number"
              value={connectTimeoutSec}
              onChange={(e) => {
                setConnectTimeoutSec(Number(e.target.value));
              }}
              disabled={!isDirectOptionSupported('connectTimeoutSec')}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
            <Checkbox
              label={t('add_dl_allow_overwrite')}
              checked={allowOverwrite}
              onChange={setAllowOverwrite}
              disabled={!isDirectOptionSupported('allowOverwrite')}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">
                {t('add_dl_custom_headers')}
              </label>
              <textarea
                rows={3}
                value={headers}
                onChange={(e) => {
                  setHeaders(e.target.value);
                }}
                placeholder={t('add_dl_headers_placeholder')}
                className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
                style={{ direction: 'ltr' }}
                disabled={!isDirectOptionSupported('headers')}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">{t('add_dl_cookies')}</label>
              <textarea
                rows={3}
                value={cookies}
                onChange={(e) => {
                  setCookies(e.target.value);
                }}
                placeholder={t('add_dl_cookies_placeholder')}
                className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
                style={{ direction: 'ltr' }}
                disabled={!isDirectOptionSupported('cookies')}
              />
            </div>
          </div>
        </div>
      )}

      {/* 5. Footer Buttons Bar */}
      <div className="flex justify-between items-center pt-3 mt-2.5 border-t border-[var(--border-color)]">
        {/* Left Side Buttons: Add, Download */}
        <div className="flex gap-2">
          <button
            onClick={() => {
              void handleSubmit(false);
            }}
            className="px-3 py-1.5 text-[11px] font-bold bg-[var(--bg-input)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canSubmitDownload}
          >
            {t('add_dl_queue_only')}
          </button>

          <button
            onClick={() => {
              void handleSubmit(true);
            }}
            className="px-4 py-1.5 text-[11px] font-bold bg-[var(--accent-primary)] hover:opacity-95 text-white rounded transition-all cursor-pointer shadow-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:opacity-50"
            disabled={!canSubmitDownload}
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
