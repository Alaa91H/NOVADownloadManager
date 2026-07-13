/* src/dialogs/download/AddDownloadDialog.tsx */
import React, { useCallback, useState, useEffect, useRef } from 'react';
import { Video, ArrowRight, RefreshCw, Link } from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { tauriClient } from '../../api/tauriClient';
import { novaClient } from '../../api/novaClient';
import type { FileType } from '../../types/desktop-ui.types';
import { detectUrlType } from '../../utils/urlDetector';
import { clearClipboardIfTextMatches, readClipboardText } from '../../utils/clipboard';
import { formatBytes } from '../../initialData';
import { isMagnetLink } from '../../utils/formatUtils';
import { TextField, SelectField, Checkbox } from '../../components/primitives';
import { useEngineCapabilities } from '../../capabilities/EngineCapabilityContext';

export const AddDownloadDialog: React.FC = () => {
  const { dialog, closeDialog, queues, settings, addTask, addToast, openDialog, t } = useAppStore();
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
  const [retryCount, setRetryCount] = useState<number>(settings.connection.defaults.retryCount);
  const [retryDelaySec, setRetryDelaySec] = useState<number>(settings.connection.defaults.retryDelaySec);
  const [timeoutSec, setTimeoutSec] = useState<number>(settings.connection.defaults.timeoutSec);
  const [connectTimeoutSec, setConnectTimeoutSec] = useState<number>(settings.connection.defaults.connectTimeoutSec);
  const [allowOverwrite, setAllowOverwrite] = useState(settings.extra.duplicateAction === 'overwrite');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showOverrideSection, setShowOverrideSection] = useState(false);
  const [authType, setAuthType] = useState('');
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [oauth2Bearer, setOauth2Bearer] = useState('');
  const [httpVersion, setHttpVersion] = useState(settings.connection.defaults.httpVersion);
  const [insecure, setInsecure] = useState(settings.connection.defaults.insecure);
  const [caCert, setCaCert] = useState(settings.connection.defaults.caCert);
  const [clientCert, setClientCert] = useState(settings.connection.defaults.clientCert);
  const [clientKey, setClientKey] = useState(settings.connection.defaults.clientKey);
  const [tlsCiphers, setTlsCiphers] = useState(settings.connection.defaults.ciphers);
  const [tlsMin, setTlsMin] = useState(settings.connection.defaults.tlsMin);
  const [maxRedirs, setMaxRedirs] = useState<number>(settings.connection.defaults.maxRedirs);
  const [keepaliveTimeSec, setKeepaliveTimeSec] = useState<number>(settings.connection.defaults.keepaliveTimeSec);
  const [tcpNoDelay, setTcpNoDelay] = useState(false);
  const [dnsServers, setDnsServers] = useState(settings.connection.defaults.dnsServers);
  const [noproxy, setNoproxy] = useState('');
  const [proxyUser, setProxyUser] = useState(settings.connection.proxyUser || '');
  const [proxyPassword, setProxyPassword] = useState(settings.connection.proxyPass || '');
  const [proxyType, setProxyType] = useState(settings.connection.proxyType || '');
  const [proxyTunnel, setProxyTunnel] = useState(settings.connection.proxyTunnel || false);
  const [ipResolve, setIpResolve] = useState(settings.connection.defaults.ipResolve);
  const [unrestrictedAuth, setUnrestrictedAuth] = useState(false);
  const [freshConnect, setFreshConnect] = useState(false);
  const [forbidReuse, setForbidReuse] = useState(false);
  const [isFetchingInfo, setIsFetchingInfo] = useState(false);
  const [infoFetched, setInfoFetched] = useState(false);
  const [probeNonce, setProbeNonce] = useState(0);
  const [detectedUrlType, setDetectedUrlType] = useState<'media' | 'download' | 'unknown'>('unknown');
  const latestUrlRef = useRef('');
  // Tracks whether the user manually chose a save location; while false the
  // probe/category logic keeps the per-type default path in sync.
  const savePathEdited = useRef(false);

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
    void tauriClient.getDownloadsDir().then((dir) => {
      if (cancelled || !dir) return;
      // Build the NOVA sub-folder inside the OS downloads directory.
      const sep = dir.includes('\\') ? '\\' : '/';
      const novaDir = `${dir.replace(/[\\/]+$/, '')}${sep}NOVA`;
      setDefaultDownloadsDir(novaDir);
      setSavePath((prev) => prev || settings.saveAndCategories.defaultFolder || novaDir);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buildSavePath = useCallback(
    (type: FileType, name: string) => {
      const configured = settings.saveAndCategories.categoryFolders[type];
      const base = settings.saveAndCategories.defaultFolder || defaultDownloadsDir || '';
      // Honour an explicitly configured per-type folder; otherwise fall back to a
      // per-type sub-folder of the base download directory so files are still
      // sorted by type when no save location has been chosen.
      let folder = configured || '';
      if (!folder && base) {
        const sub: Record<FileType, string> = {
          video: 'Video',
          audio: 'Audio',
          document: 'Documents',
          compressed: 'Archives',
          program: 'Programs',
          other: 'Other',
        };
        const sep = base.includes('\\') ? '\\' : '/';
        folder = `${base.replace(/[\\/]+$/, '')}${sep}${sub[type]}`;
      }
      if (!folder || !name) return folder || name;
      const sep = folder.includes('\\') ? '\\' : '/';
      return `${folder.replace(/[\\/]+$/, '')}${sep}${name}`;
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
              authType: isDirectOptionSupported('authType') ? authType || undefined : undefined,
              username: isDirectOptionSupported('username') ? authUsername.trim() || undefined : undefined,
              password: isDirectOptionSupported('password') ? authPassword.trim() || undefined : undefined,
              oauth2Bearer: isDirectOptionSupported('oauth2Bearer') ? oauth2Bearer.trim() || undefined : undefined,
              insecure: isDirectOptionSupported('insecure') ? insecure || undefined : undefined,
              httpVersion: isDirectOptionSupported('httpVersion') ? httpVersion || undefined : undefined,
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
          if (!savePathEdited.current) setSavePath(buildSavePath(detectedType, detectedName));
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
          if (!savePathEdited.current) setSavePath(buildSavePath(detectedType, detectedName));
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
    authType,
    authUsername,
    authPassword,
    httpVersion,
    insecure,
    oauth2Bearer,
    settings.saveAndCategories,
    defaultDownloadsDir,
    buildSavePath,
    isDirectOptionSupported,
    probeNonce,
  ]);

  // Auto-redirect to MediaDownloadDialog when a media URL is detected
  useEffect(() => {
    if (detectedUrlType === 'media' && url.trim().startsWith('http')) {
      const mediaUrl = url.trim();
      const timer = setTimeout(() => {
        setUrl('');
        openDialog('mediaDownload', mediaUrl);
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
      savePathEdited.current = true;
      setSavePath(`${picked}\\${fileName || 'download'}`);
    } else {
      addToast('info', t('add_dl_browse_folders'), t('add_dl_directory_picker_error'));
    }
  };

  const handleSubmit = async (downloadImmediately: boolean) => {
    // Always persist the original URL and let the download engine resolve the
    // live target (following HTTP 3xx and HTML meta-refresh interstitials) at
    // the start of every download and resume. Storing a pre-resolved mirror URL
    // would bake in a time-limited token that goes stale on resume.
    const submittedUrl = url.trim();
    const downloadUrl = submittedUrl;
    const effectiveReferer = referer.trim();

    const directBlock = engineCapabilities.directBlockedReason(submittedUrl);
    if (directBlock) {
      addToast('error', t('add_dl_direct_engine_unavailable'), directBlock);
      return;
    }

    if (
      settings.extra.vpnEnabled &&
      settings.extra.vpnKillSwitch &&
      ((settings.extra.vpnMode === 'proxy' && !settings.extra.vpnProxyUrl.trim()) ||
        (settings.extra.vpnMode === 'bind' && !settings.extra.vpnBindAddress.trim()))
    ) {
      addToast('error', t('add_dl_vpn_routing_error'), t('add_dl_vpn_incomplete'));
      return;
    }

    const vpnRoute = await tauriClient.validateVpnRoute(settings);
    if (!vpnRoute.ok) {
      addToast('error', t('add_dl_vpn_routing_error'), vpnRoute.message);
      return;
    }

    if (!submittedUrl || !fileName) {
      addToast('error', t('toast_error_title'), t('add_dl_enter_valid_link'));
      return;
    }

    if (submittedUrl.startsWith('magnet:') || submittedUrl.toLowerCase().endsWith('.torrent')) {
      addToast(
        'error',
        t('toast_error_title'),
        t('add_dl_unsupported_torrent'),
      );
      return;
    }

    const urlType = detectUrlType(submittedUrl);
    if (urlType === 'media') {
      clearSensitiveDialogState();
      openDialog('mediaDownload', submittedUrl);
      return;
    }

    const directOptions = engineCapabilities.sanitizeDirectOptions({
      userAgent: userAgent.trim() || undefined,
      referer: effectiveReferer || undefined,
      headers: headers.trim() || undefined,
      cookies: cookies.trim() || undefined,
      proxy: proxy.trim() || undefined,
      noproxy: noproxy.trim() || undefined,
      sourceAddress: configuredSourceAddress || undefined,
      speedLimitKbs: speedLimitKbs > 0 ? speedLimitKbs : undefined,
      retryCount: retryCount > 0 ? retryCount : undefined,
      retryDelaySec: retryDelaySec > 0 ? retryDelaySec : undefined,
      timeoutSec: timeoutSec > 0 ? timeoutSec : undefined,
      connectTimeoutSec: connectTimeoutSec > 0 ? connectTimeoutSec : undefined,
      allowOverwrite: allowOverwrite ? undefined : false,
      segmented: supportsSegmentedDownloads && effectiveConnections > 1 && resumable ? true : undefined,
      authType: authType || undefined,
      username: authUsername.trim() || undefined,
      password: authPassword.trim() || undefined,
      oauth2Bearer: oauth2Bearer.trim() || undefined,
      proxyUser: proxyUser.trim() || undefined,
      proxyPassword: proxyPassword.trim() || undefined,
      proxyType: proxyType || undefined,
      proxyTunnel: proxyTunnel || undefined,
      unrestrictedAuth: unrestrictedAuth || undefined,
      ipResolve: ipResolve || undefined,
      httpVersion: httpVersion || undefined,
      insecure: insecure || undefined,
      caCert: caCert.trim() || undefined,
      cert: clientCert.trim() || undefined,
      key: clientKey.trim() || undefined,
      ciphers: tlsCiphers.trim() || undefined,
      tlsMin: tlsMin || undefined,
      maxRedirs: maxRedirs !== 20 ? maxRedirs : undefined,
      keepaliveTimeSec: keepaliveTimeSec > 0 ? keepaliveTimeSec : undefined,
      tcpNoDelay: tcpNoDelay || undefined,
      dnsServers: dnsServers.trim() || undefined,
      freshConnect: freshConnect || undefined,
      forbidReuse: forbidReuse || undefined,
    });

    const task = await addTask(
      {
        name: fileName,
        url: downloadUrl,
        fileType,
        status: downloadImmediately ? 'downloading' : 'queued',
        sizeBytes,
        category,
        queueId,
        connections: effectiveConnections,
        resumable,
        savePath,
        description:
          description || (downloadUrl !== submittedUrl ? `Original download page: ${submittedUrl}` : description),
        referer: effectiveReferer,
        directOptions,
        elapsedSeconds: 0,
      },
      downloadImmediately,
    );

    if (task) {
      cleanupSensitiveLink(submittedUrl);
      if (!downloadImmediately) {
        clearSensitiveDialogState();
        closeDialog();
      }
    }
  };

  const queueOptions = queues.map((q) => ({ value: q.id, label: q.name }));
  const connectionOptions = supportsSegmentedDownloads
    ? [
        { value: 0, label: t('add_dl_automatic_default') },
        { value: 8, label: t('add_dl_threads_8') },
        { value: 16, label: t('add_dl_threads_16') },
        { value: 24, label: t('add_dl_threads_24') },
        { value: 32, label: t('add_dl_threads_32') },
      ]
    : [{ value: 1, label: t('add_dl_single_connection') }];

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
      {!directEngineReady && (
        <div className="rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] p-2 text-[11px] text-[var(--text-primary)]">
          {t('add_dl_direct_engine_error')}
        </div>
      )}
      {showAdvanced && supportedDirectOptions.size > 0 && (
        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-hover)]/30 p-2 text-[10px] text-[var(--text-secondary)]">
          {t('add_dl_advanced_info')}
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
                    addToast('error', t('add_dl_paste_clipboard'), t('add_dl_clipboard_error'));
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

      {/* Magnet Link Detection Banner */}
      {isMagnetLink(url) && (
        <div className="bg-[var(--warning-bg)] border border-[var(--warning-border)] rounded-lg p-2.5 flex items-center gap-2">
          <Link className="w-4 h-4 text-[var(--warning)] shrink-0" />
          <span className="text-[11px] text-[var(--warning)] font-medium">{t('add_dl_magnet_detected')}</span>
        </div>
      )}

      {/* Media URL Detection Banner */}
      {detectedUrlType === 'media' && (
        <div className="bg-[var(--danger-bg)] border border-[var(--danger-border)] rounded-lg p-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs">
            <Video className="w-4 h-4 text-[var(--danger)] shrink-0" />
            <span className="text-[var(--text-primary)]">
              {t('add_dl_media_detected')}
            </span>
          </div>
          <button
            onClick={() => {
              const mediaUrl = url.trim();
              setUrl('');
              openDialog('mediaDownload', mediaUrl);
            }}
            className="shrink-0 px-3 py-1 text-[10px] font-bold bg-[var(--danger)] hover:bg-[var(--danger)] text-white rounded transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <Video className="w-3 h-3" />
            <span>{t('add_dl_open_media_downloader')}</span>
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
                savePathEdited.current = true;
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
            const sizeLabel = isFetchingInfo ? t('add_dl_checking') : sizeKnown ? formatBytes(sizeBytes) : t('add_dl_unknown_size');
            const sizeTitle = isFetchingInfo
              ? t('add_dl_calculating_size')
              : sizeKnown
                ? t('add_dl_file_size')
                : probeError || t('add_dl_size_unavailable');

            if (isFetchingInfo) {
              borderColor = 'border-[var(--warning)] bg-[var(--warning)]/5 text-[var(--warning)] animate-pulse';
              textColor = 'text-[var(--warning)]';
            } else if (infoFetched) {
              if (sizeKnown) {
                borderColor = 'border-[var(--success)] bg-[var(--success-bg)] text-[var(--success)] dark:text-[var(--success)]';
                textColor = 'text-[var(--success)] dark:text-[var(--success)]';
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
                savePathEdited.current = false;
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
            title={t('add_dl_advanced_options')}
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
                // Manually changing the category re-applies the per-type default
                // path unless the user has already chosen a custom location.
                if (!savePathEdited.current) {
                  setSavePath(buildSavePath(newCat, fileName || 'file_download.bin'));
                }
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
            placeholder="Enter notes or description for this file..."
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
              label="Referer"
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
              label="User-Agent"
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
              label="Proxy"
              value={proxy}
              onChange={(e) => {
                setProxy(e.target.value);
              }}
              placeholder="http://127.0.0.1:8080"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
              disabled={!isDirectOptionSupported('proxy')}
            />
            <SelectField
              label={t('add_dl_ip_resolve')}
              value={ipResolve}
              onChange={(e) => { setIpResolve(e.target.value); }}
              options={[
                { value: '', label: t('add_dl_system_default') },
                { value: '4', label: t('add_dl_force_ipv4') },
                { value: '6', label: t('add_dl_force_ipv6') },
              ]}
              disabled={!isDirectOptionSupported('ipResolve')}
            />
            <SelectField
              label={t('add_dl_proxy_type')}
              value={proxyType}
              onChange={(e) => { setProxyType(e.target.value); }}
              options={[
                { value: '', label: t('add_dl_proxy_default') },
                { value: 'socks4', label: 'SOCKS4' },
                { value: 'socks5', label: 'SOCKS5' },
                { value: 'socks4a', label: 'SOCKS4a (remote DNS)' },
                { value: 'socks5h', label: 'SOCKS5h (remote DNS)' },
              ]}
              disabled={!isDirectOptionSupported('proxyType')}
            />
            <div className="flex items-center gap-6 pt-5">
              <Checkbox
                label={t('add_dl_proxy_tunnel')}
                checked={proxyTunnel}
                onChange={setProxyTunnel}
                disabled={!isDirectOptionSupported('proxyTunnel')}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <TextField
              label="Speed Limit (KB/s)"
              type="number"
              value={speedLimitKbs}
              onChange={(e) => {
                setSpeedLimitKbs(Number(e.target.value));
              }}
              disabled={!isDirectOptionSupported('speedLimitKbs')}
            />
            <TextField
              label="Retries"
              type="number"
              value={retryCount}
              onChange={(e) => {
                setRetryCount(Number(e.target.value));
              }}
              disabled={!isDirectOptionSupported('retryCount')}
            />
            <TextField
              label="Retry Delay (s)"
              type="number"
              value={retryDelaySec}
              onChange={(e) => {
                setRetryDelaySec(Number(e.target.value));
              }}
              disabled={!isDirectOptionSupported('retryDelaySec')}
            />
            <TextField
              label="Timeout (s)"
              type="number"
              value={timeoutSec}
              onChange={(e) => {
                setTimeoutSec(Number(e.target.value));
              }}
              disabled={!isDirectOptionSupported('timeoutSec')}
            />
            <TextField
              label="Connect Timeout (s)"
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
                {t('batch_custom_headers')}
              </label>
              <textarea
                rows={3}
                value={headers}
                onChange={(e) => {
                  setHeaders(e.target.value);
                }}
                placeholder="Header-Name: value"
                className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
                style={{ direction: 'ltr' }}
                disabled={!isDirectOptionSupported('headers')}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">{t('batch_cookies')}</label>
              <textarea
                rows={3}
                value={cookies}
                onChange={(e) => {
                  setCookies(e.target.value);
                }}
                placeholder="name=value; other=value"
                className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
                style={{ direction: 'ltr' }}
                disabled={!isDirectOptionSupported('cookies')}
              />
            </div>
          </div>

          {/* ── Override Defaults (unified) ── */}
          <div className="border-t border-[var(--border-color)]/40 pt-3 mt-1">
            <button
              type="button"
              onClick={() => { setShowOverrideSection(!showOverrideSection); }}
              className="flex items-center gap-2 w-full text-left cursor-pointer group"
            >
              <span className="text-[10px] md:text-[11px] font-bold text-[var(--text-secondary)] uppercase tracking-wider">
                {t('add_dl_override_defaults')}
              </span>
              <span className="text-[10px] text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors">
                {showOverrideSection ? '▾ ' + t('add_dl_hide_overrides') : '▸ ' + t('add_dl_show_overrides')}
              </span>
            </button>

            {showOverrideSection && (
              <div className="space-y-3 mt-2 animate-in fade-in duration-150">
                {/* Authentication */}
                <div className="bg-[var(--bg-input)]/30 rounded-lg p-3 border border-[var(--border-color)]/30">
                  <span className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-wider block mb-2">
                    {t('add_dl_authentication')}
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <SelectField
                      label={t('add_dl_auth_type')}
                      value={authType}
                      onChange={(e) => { setAuthType(e.target.value); }}
                      options={[
                        { value: '', label: t('add_dl_auth_none') },
                        { value: 'basic', label: t('add_dl_auth_basic') },
                        { value: 'digest', label: t('add_dl_auth_digest') },
                        { value: 'ntlm', label: t('add_dl_auth_ntlm') },
                        { value: 'negotiate', label: t('add_dl_auth_negotiate') },
                        { value: 'any', label: t('add_dl_auth_any') },
                      ]}
                      disabled={!isDirectOptionSupported('authType')}
                    />
                    <TextField label={t('add_dl_username')} value={authUsername} onChange={(e) => { setAuthUsername(e.target.value); }} placeholder="username" className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} disabled={!isDirectOptionSupported('username')} />
                    <TextField label={t('add_dl_password')} value={authPassword} onChange={(e) => { setAuthPassword(e.target.value); }} placeholder="password" className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} disabled={!isDirectOptionSupported('password')} />
                    <TextField label={t('add_dl_oauth2_bearer')} value={oauth2Bearer} onChange={(e) => { setOauth2Bearer(e.target.value); }} placeholder="eyJhbGciOi..." className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} disabled={!isDirectOptionSupported('oauth2Bearer')} />
                    <TextField label={t('add_dl_proxy_username')} value={proxyUser} onChange={(e) => { setProxyUser(e.target.value); }} placeholder="proxy-user" className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} disabled={!isDirectOptionSupported('proxyUser')} />
                    <TextField label={t('add_dl_proxy_password')} value={proxyPassword} onChange={(e) => { setProxyPassword(e.target.value); }} placeholder="proxy-pass" className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} disabled={!isDirectOptionSupported('proxyPassword')} />
                    <div className="flex items-center gap-6 pt-5 md:col-span-2">
                      <Checkbox label={t('add_dl_unrestricted_auth')} checked={unrestrictedAuth} onChange={setUnrestrictedAuth} disabled={!isDirectOptionSupported('unrestrictedAuth')} />
                    </div>
                  </div>
                </div>

                {/* TLS / Security */}
                <div className="bg-[var(--bg-input)]/30 rounded-lg p-3 border border-[var(--border-color)]/30">
                  <span className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-wider block mb-2">
                    {t('add_dl_tls_security')}
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <SelectField label={t('add_dl_http_version')} value={httpVersion} onChange={(e) => { setHttpVersion(e.target.value); }} options={[{ value: '', label: 'Auto' }, { value: '1.0', label: 'HTTP/1.0' }, { value: '1.1', label: 'HTTP/1.1' }, { value: '2', label: 'HTTP/2' }, { value: '2-prior-knowledge', label: 'HTTP/2 Prior Knowledge' }, { value: '3', label: 'HTTP/3' }]} disabled={!isDirectOptionSupported('httpVersion')} />
                    <SelectField label={t('add_dl_tls_min')} value={tlsMin} onChange={(e) => { setTlsMin(e.target.value); }} options={[{ value: '', label: 'Default' }, { value: '1.0', label: 'TLS 1.0' }, { value: '1.1', label: 'TLS 1.1' }, { value: '1.2', label: 'TLS 1.2' }, { value: '1.3', label: 'TLS 1.3' }]} disabled={!isDirectOptionSupported('tlsMin')} />
                    <div className="flex items-center gap-6 pt-5"><Checkbox label={t('add_dl_insecure')} checked={insecure} onChange={setInsecure} disabled={!isDirectOptionSupported('insecure')} /></div>
                    <TextField label={t('add_dl_ca_cert')} value={caCert} onChange={(e) => { setCaCert(e.target.value); }} placeholder="/path/to/cacert.pem" className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} disabled={!isDirectOptionSupported('caCert')} />
                    <TextField label={t('add_dl_client_cert')} value={clientCert} onChange={(e) => { setClientCert(e.target.value); }} placeholder="/path/to/client.crt" className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} disabled={!isDirectOptionSupported('cert')} />
                    <TextField label={t('add_dl_client_key')} value={clientKey} onChange={(e) => { setClientKey(e.target.value); }} placeholder="/path/to/client.key" className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} disabled={!isDirectOptionSupported('key')} />
                    <TextField label={t('add_dl_cipher_suites')} value={tlsCiphers} onChange={(e) => { setTlsCiphers(e.target.value); }} placeholder="ECDHE+AESGCM:!aNULL" className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} disabled={!isDirectOptionSupported('ciphers')} />
                  </div>
                </div>

                {/* Connection Tuning */}
                <div className="bg-[var(--bg-input)]/30 rounded-lg p-3 border border-[var(--border-color)]/30">
                  <span className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-wider block mb-2">
                    {t('add_dl_connection_tuning')}
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <TextField label={t('add_dl_max_redirects')} type="number" value={maxRedirs} onChange={(e) => { setMaxRedirs(Number(e.target.value)); }} disabled={!isDirectOptionSupported('maxRedirs')} />
                    <TextField label={t('add_dl_keepalive')} type="number" value={keepaliveTimeSec} onChange={(e) => { setKeepaliveTimeSec(Number(e.target.value)); }} disabled={!isDirectOptionSupported('keepaliveTimeSec')} />
                    <div className="flex items-center gap-6 pt-5"><Checkbox label={t('add_dl_tcp_no_delay')} checked={tcpNoDelay} onChange={setTcpNoDelay} disabled={!isDirectOptionSupported('tcpNoDelay')} /></div>
                    <TextField label={t('add_dl_dns_servers')} value={dnsServers} onChange={(e) => { setDnsServers(e.target.value); }} placeholder="1.1.1.1, 8.8.8.8" className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} disabled={!isDirectOptionSupported('dnsServers')} />
                    <TextField label={t('add_dl_noproxy')} value={noproxy} onChange={(e) => { setNoproxy(e.target.value); }} placeholder="localhost, 127.0.0.1, .local" className="font-mono" style={{ direction: 'ltr', textAlign: 'left' }} disabled={!isDirectOptionSupported('noproxy')} />
                    <div className="flex items-center gap-6 pt-5 md:col-span-2">
                      <Checkbox label={t('add_dl_fresh_connect')} checked={freshConnect} onChange={setFreshConnect} disabled={!isDirectOptionSupported('freshConnect')} />
                      <Checkbox label={t('add_dl_forbid_reuse')} checked={forbidReuse} onChange={setForbidReuse} disabled={!isDirectOptionSupported('forbidReuse')} />
                    </div>
                  </div>
                </div>
              </div>
            )}
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
