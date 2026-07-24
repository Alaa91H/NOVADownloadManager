/* src/pages/MediaDownloadPage.tsx */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowLeft,
  FolderOpen,
  Music,
  Video,
  Code,
  Download,
  AlertCircle,
  Loader2,
  Info,
  ListMusic,
  Globe,
  Zap,
  Settings2,
  Clock,
  Film,
  Radio,
  ChevronRight,
  LayoutGrid,
  FileText,
} from 'lucide-react';
import {
  useDialogData,
  useDialogActions,
  useSettingsData,
  useSettingsActions,
  useTaskActions,
  useToastActions,
  useNavigationActions,
  useI18n,
} from '../store/selectors';
import { novaClient, type MediaFormat, type MediaPlaylistEntry } from '../api/novaClient';
import { tauriClient } from '../api/tauriClient';
import { clearClipboardIfTextMatches } from '../utils/clipboard';
import { TextField } from '../components/primitives';
import { formatBytes } from '../initialData';
import { useEngineCapabilities } from '../capabilities/EngineCapabilityContext';
import type { AppSettings } from '../types/desktop-ui.types';
import { formatDuration, bestVideoFormat, resolutionLabel, type AdvancedTab } from '../components/media/mediaHelpers';
import { EngineStatusBar } from '../components/media/EngineStatusBar';
import { AdvancedTabs, type AdvancedState } from '../components/media/AdvancedTabs';
import { QualityGrid, type QualityOption } from '../components/media/QualityGrid';
import { AudioGrid, type AudioOption } from '../components/media/AudioGrid';
import { PlaylistBrowser } from '../components/media/PlaylistBrowser';

/* ----------------------------------- main component ------------------------------------ */

export const MediaDownloadPage: React.FC = () => {
  const dialog = useDialogData();
  const { openDialog, closeDialog } = useDialogActions();
  const settings = useSettingsData();
  const { updateSettings } = useSettingsActions();
  const { addTask } = useTaskActions();
  const { addToast } = useToastActions();
  const { setActivePage } = useNavigationActions();
  const t = useI18n();
  const engineCapabilities = useEngineCapabilities();

  // Local UI state
  const [url, setUrl] = useState<string>(() => (typeof dialog.payload === 'string' ? dialog.payload : ''));
  const [targetType, _setTargetType] = useState<'video' | 'playlist'>('video');
  const [saveMode, setSaveMode] = useState<'video' | 'audio'>('video');
  const [savePath, setSavePath] = useState<string>(settings.saveAndCategories.defaultFolder || '');
  const [selectedQueue, _setSelectedQueue] = useState<string>('main');
  const [quality, setQuality] = useState<string>(settings.extra.videoQuality || 'best');
  const [audioFormat, setAudioFormat] = useState<string>('m4a');
  const [ffmpegEnabled, setFfmpegEnabled] = useState<boolean>(settings.extra.ffmpegAutoMerge || false);
  const [convertBitrate, setConvertBitrate] = useState<string>(
    ((settings.extra as Record<string, unknown>).convertBitrate as string) || '320k',
  );
  const [outputTemplate, setOutputTemplate] = useState<string>(
    ((settings.extra as Record<string, unknown>).defaultOutputTemplate as string) || '%(title)s.%(ext)s',
  );

  const [advancedState, setAdvancedState] = useState<AdvancedState>({
    downloadSubtitles: false,
    autoSubtitles: false,
    embedSubtitles: false,
    writeThumbnail: false,
    embedThumbnail: false,
    writeInfoJson: false,
    writeDescription: false,
    splitChapters: false,
    subtitleLanguages: '',
    formatSelectorOverride: '',
    formatSort: '',
    downloadSections: '',
    matchFilter: '',
    remuxFormat: '',
    sponsorBlock: '',
    mediaProxy: '',
    cookiesFromBrowser: '',
    mediaUserAgent: '',
    mediaReferer: '',
    mediaHeaders: '',
    mediaCookies: '',
    rateLimitKbs: 0,
    retries: 0,
    fragmentRetries: 0,
    concurrentFragments: 0,
    sleepIntervalSec: 0,
    maxSleepIntervalSec: 0,
  });

  const handleAdvancedChange = <K extends keyof AdvancedState>(key: K, value: AdvancedState[K]) => {
    setAdvancedState((prev) => ({ ...prev, [key]: value }));
  };

  const configuredSourceAddress =
    settings.extra.vpnEnabled && settings.extra.vpnMode === 'bind' ? settings.extra.vpnBindAddress.trim() : '';

  /* -- probe state -- */
  const [probeResult, setProbeResult] = useState<{
    id: string;
    title: string;
    duration: number;
    durationString: string;
    thumbnail: string;
    webpageUrl: string;
    formats: MediaFormat[];
  } | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [probeError, setProbeError] = useState('');
  const [ffmpegProbe, setFfmpegProbe] = useState<boolean | null>(null);

  /* -- playlist state -- */
  const [playlistResult, setPlaylistResult] = useState<{ title: string; entries: MediaPlaylistEntry[] } | null>(null);
  const [isProbingPlaylist, setIsProbingPlaylist] = useState(false);
  const [playlistError, setPlaylistError] = useState('');
  const [selectedPlaylistItems, setSelectedPlaylistItems] = useState<Set<number>>(new Set());
  const [selectAllPlaylist, setSelectAllPlaylist] = useState(true);

  /* -- UI state -- */
  const [advancedTab, setAdvancedTab] = useState<AdvancedTab>('subtitles');

  // Accordion state: only one left-side panel open at a time
  const [openPanel, setOpenPanel] = useState<'mode' | 'quality' | 'audio' | 'output' | 'advanced' | null>('mode');

  const togglePanel = (id: 'mode' | 'quality' | 'audio' | 'output' | 'advanced') => {
    setOpenPanel((prev) => (prev === id ? null : id));
  };

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestUrlRef = useRef('');

  const isPlaylistUrl = targetType === 'playlist' || /[?&]list=[^&]/.test(url);

  /* -- URL tracking -- */
  useEffect(() => {
    latestUrlRef.current = url;
  }, [url]);

  /* -- clipboard cleanup on unmount -- */
  useEffect(() => {
    return () => {
      if (settings.extra.preventClipboardHistory) {
        void clearClipboardIfTextMatches(latestUrlRef.current);
      }
    };
  }, [settings.extra.preventClipboardHistory]);

  /* -- FFmpeg availability check -- */
  useEffect(() => {
    if (engineCapabilities.postProcessingReady) return;
    novaClient
      .checkFfmpeg()
      .then((r) => {
        setFfmpegProbe(r.available);
      })
      .catch(() => {
        setFfmpegProbe(false);
      });
  }, [engineCapabilities.postProcessingReady]);

  const ffmpegAvailable: boolean | null = engineCapabilities.postProcessingReady ? true : ffmpegProbe;

  /* -- probe logic -- */
  const doProbe = useCallback(
    async (probeUrl: string) => {
      if (!probeUrl.trim().startsWith('http')) return;
      if (isPlaylistUrl) {
        setIsProbingPlaylist(true);
        setPlaylistError('');
        setPlaylistResult(null);
        try {
          const result = await novaClient.probePlaylist(probeUrl.trim());
          setPlaylistResult(result);
          setSelectedPlaylistItems(new Set(result.entries.map((e) => e.index)));
        } catch (e) {
          setPlaylistError(e instanceof Error ? e.message : t('media_playlist_probe_failed'));
          setPlaylistResult(null);
        } finally {
          setIsProbingPlaylist(false);
        }
      } else {
        setIsProbing(true);
        setProbeError('');
        try {
          const result = await novaClient.probeMedia(probeUrl.trim());
          setProbeResult(result);
          const videoFormats = result.formats.filter(
            (f) => f.vcodec && f.vcodec !== 'none' && f.height != null && f.height > 0,
          );
          if (videoFormats.length > 0) {
            const best = bestVideoFormat(videoFormats, 1080);
            if (best?.height) setQuality(`${String(best.height)}p`);
          }
        } catch (e) {
          setProbeError(e instanceof Error ? e.message : t('media_probe_failed'));
          setProbeResult(null);
        } finally {
          setIsProbing(false);
        }
      }
    },
    [isPlaylistUrl, t],
  );

  /* -- URL change side effects -- */
  const [prevUrl, setPrevUrl] = useState(url);
  if (prevUrl !== url) {
    setPrevUrl(url);
    if (!url.trim().startsWith('http')) {
      setProbeResult(null);
      setProbeError('');
      setPlaylistResult(null);
      setPlaylistError('');
    }
  }
  const [prevIsPlaylistUrl, setPrevIsPlaylistUrl] = useState(isPlaylistUrl);
  if (prevIsPlaylistUrl !== isPlaylistUrl) {
    setPrevIsPlaylistUrl(isPlaylistUrl);
    if (isPlaylistUrl) setProbeResult(null);
    else setPlaylistResult(null);
  }

  /* -- debounced probe trigger -- */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!url.trim().startsWith('http')) return;
    debounceRef.current = setTimeout(() => {
      void doProbe(url);
    }, 800);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [url, doProbe]);

  /* -- computed values -- */
  const isProbingAny = isProbing || isProbingPlaylist;
  const ytDlpReady = engineCapabilities.mediaReady;
  const _ffmpegReady = engineCapabilities.postProcessingReady;

  const requiresFfmpeg = (() => {
    if (!probeResult || saveMode === 'audio') return true;
    if (quality === 'best') return true;
    const height = parseInt(quality, 10);
    if (isNaN(height)) return true;
    const selectedFormats = probeResult.formats.filter(
      (f) => f.height != null && f.height >= height && f.vcodec && f.vcodec !== 'none',
    );
    return selectedFormats.every((f) => f.acodec === 'none' || f.acodec === '');
  })();

  const dynamicQualityOptions: QualityOption[] = (() => {
    const opts: QualityOption[] = [];
    opts.push({
      value: 'best',
      label: 'Best Quality Available',
      size: '',
      sizeBytes: 0,
      needsFfmpeg: true,
      codecInfo: '',
      height: 0,
      fps: 0,
      ext: '',
      formatNote: '',
      hasAudio: false,
      tbr: 0,
    });
    // If we don't have probe results yet, still expose common quality choices
    if (!probeResult || saveMode !== 'video') {
      const fallbackHeights = [4320, 2880, 2160, 1440, 1080, 720, 480, 360, 240, 144];
      for (const h of fallbackHeights) {
        opts.push({
          value: `${String(h)}p`,
          label: resolutionLabel(h),
          size: '',
          sizeBytes: 0,
          needsFfmpeg: true,
          codecInfo: '',
          height: h,
          fps: 0,
          ext: '',
          formatNote: '',
          hasAudio: false,
          tbr: 0,
        });
      }
      return opts;
    }
    const sorted = [...probeResult.formats]
      .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height != null && f.height > 0)
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    const seen = new Set<number>();
    for (const fmt of sorted) {
      if (fmt.height == null || seen.has(fmt.height)) continue;
      seen.add(fmt.height);
      const hasAudio = !!(fmt.acodec && fmt.acodec !== 'none');
      const fileSize = fmt.filesize || fmt.filesizeApprox || 0;
      opts.push({
        value: `${String(fmt.height)}p`,
        label: resolutionLabel(fmt.height),
        size: fileSize ? formatBytes(fileSize) : '',
        sizeBytes: fileSize,
        needsFfmpeg: !hasAudio,
        codecInfo: fmt.vcodec.split('.')[0] || '',
        height: fmt.height,
        fps: fmt.fps || 0,
        ext: fmt.ext,
        formatNote: fmt.formatNote || '',
        hasAudio,
        tbr: fmt.tbr || 0,
      });
    }
    return opts;
  })();

  const dynamicAudioOptions: AudioOption[] = (() => {
    const opts: AudioOption[] = [
      {
        value: 'mp3',
        label: 'MP3',
        needsFfmpeg: true,
        bitrate: '320kbps',
        sizeBytes: 0,
        ext: 'mp3',
        description: 'Best Compatibility',
      },
      {
        value: 'm4a',
        label: 'M4A',
        needsFfmpeg: false,
        bitrate: '',
        sizeBytes: 0,
        ext: 'm4a',
        description: 'AAC · Original Quality',
      },
      {
        value: 'flac',
        label: 'FLAC',
        needsFfmpeg: true,
        bitrate: '',
        sizeBytes: 0,
        ext: 'flac',
        description: 'Lossless Archive',
      },
      {
        value: 'wav',
        label: 'WAV',
        needsFfmpeg: true,
        bitrate: '',
        sizeBytes: 0,
        ext: 'wav',
        description: 'Uncompressed PCM',
      },
    ];
    if (probeResult) {
      const audioOnly = probeResult.formats.filter(
        (f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'),
      );
      if (audioOnly.length > 0) {
        const seenExts = new Set<string>();
        for (const f of audioOnly) {
          const key = f.ext.toLowerCase();
          if (seenExts.has(key)) continue;
          seenExts.add(key);
          const abr = f.abr ? `${f.abr.toFixed(0)}kbps` : '';
          opts.push({
            value: key,
            label: f.ext.toUpperCase(),
            needsFfmpeg: false,
            bitrate: abr,
            sizeBytes: f.filesize || f.filesizeApprox || 0,
            ext: key,
            description: `Original Stream${abr ? ` · ${abr}` : ''}`,
          });
        }
      }
    }
    return opts;
  })();

  const selectedFormat = (() => {
    if (!probeResult || saveMode !== 'video' || quality === 'best') return null;
    const h = parseInt(quality, 10);
    if (isNaN(h)) return null;
    return bestVideoFormat(probeResult.formats, h);
  })();

  const selectedFormatSize = (() => {
    if (saveMode === 'video') {
      if (quality === 'best') {
        const best = bestVideoFormat(probeResult?.formats || []);
        return best ? best.filesize || best.filesizeApprox || 0 : 0;
      }
      return selectedFormat ? selectedFormat.filesize || selectedFormat.filesizeApprox || 0 : 0;
    }
    const opt = dynamicAudioOptions.find((o) => o.value === audioFormat);
    return opt?.sizeBytes || 0;
  })();

  const totalSize = (() => {
    if (isPlaylistUrl && playlistResult) {
      if (selectAllPlaylist) return selectedFormatSize * playlistResult.entries.length;
      return selectedFormatSize * selectedPlaylistItems.size;
    }
    return selectedFormatSize;
  })();

  /* -- handlers -- */
  /* Persist chosen quality to settings so the user's preference is remembered */
  useEffect(() => {
    // Avoid updating during initial mount if settings already match
    try {
      const current = settings.extra.videoQuality || 'best';
      if (current === quality) return;
      const updated: AppSettings = { ...settings, extra: { ...settings.extra, videoQuality: quality } };
      updateSettings(updated);
    } catch {
      const updated: AppSettings = { ...settings, extra: { ...settings.extra, videoQuality: quality } };
      updateSettings(updated);
    }
  }, [quality, settings, updateSettings]);
  const handleTemplatePreset = (preset: string) => {
    setOutputTemplate(preset);
  };

  const clearSensitiveDialogState = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setUrl('');
    setProbeResult(null);
    setProbeError('');
    setPlaylistResult(null);
    setPlaylistError('');
    setSelectedPlaylistItems(new Set());
    setIsProbing(false);
    setIsProbingPlaylist(false);
  };

  const cleanupSensitiveLink = (value: string) => {
    if (settings.extra.preventClipboardHistory) {
      void clearClipboardIfTextMatches(value);
    }
  };

  const handleBack = () => {
    const currentUrl = latestUrlRef.current;
    clearSensitiveDialogState();
    cleanupSensitiveLink(currentUrl);
    closeDialog();
  };

  const handleStartDownload = async () => {
    const submittedUrl = url.trim();
    if (!submittedUrl || !submittedUrl.startsWith('http')) {
      addToast('error', t('media_invalid_link'), t('media_invalid_link_msg'));
      return;
    }

    if (!engineCapabilities.mediaReady) {
      addToast(
        'error',
        t('media_engine_unavailable'),
        engineCapabilities.mediaBlockedReason() || t('media_engine_not_ready'),
      );
      return;
    }

    try {
      if (
        settings.extra.vpnEnabled &&
        settings.extra.vpnKillSwitch &&
        ((settings.extra.vpnMode === 'proxy' && !settings.extra.vpnProxyUrl.trim()) ||
          (settings.extra.vpnMode === 'bind' && !settings.extra.vpnBindAddress.trim()))
      ) {
        addToast('error', t('add_dl_vpn_routing_error'), t('media_vpn_incomplete'));
        return;
      }

      const vpnRoute = await tauriClient.validateVpnRoute(settings);
      if (!vpnRoute.ok) {
        addToast('error', t('add_dl_vpn_routing_error'), vpnRoute.message);
        return;
      }

      if (isPlaylistUrl && playlistResult && !selectAllPlaylist && selectedPlaylistItems.size === 0) {
        addToast('error', t('media_no_selection'), t('media_no_selection_msg'));
        return;
      }

      const isPlaylist = isPlaylistUrl;
      const fileType = saveMode === 'audio' ? 'audio' : 'video';

      let playlistItemsStr = '';
      if (isPlaylist && playlistResult && !selectAllPlaylist) {
        playlistItemsStr = Array.from<number>(selectedPlaylistItems)
          .sort((a, b) => a - b)
          .join(',');
      }

      const effectiveQuality = requiresFfmpeg && !engineCapabilities.postProcessingReady ? 'best' : quality;

      const {
        mediaProxy,
        cookiesFromBrowser,
        mediaUserAgent,
        mediaReferer,
        mediaHeaders,
        mediaCookies,
        rateLimitKbs,
        retries,
        fragmentRetries,
        concurrentFragments,
        sleepIntervalSec,
        maxSleepIntervalSec,
        downloadSubtitles,
        subtitleLanguages,
        autoSubtitles,
        embedSubtitles,
        writeThumbnail,
        embedThumbnail,
        writeInfoJson,
        writeDescription,
        splitChapters,
        sponsorBlock,
        formatSelectorOverride,
        formatSort,
        downloadSections,
        matchFilter,
        remuxFormat,
      } = advancedState;

      const mediaOptions = engineCapabilities.sanitizeMediaOptions({
        mode: saveMode,
        quality: effectiveQuality,
        formatSelector: formatSelectorOverride.trim() || undefined,
        formatSort: formatSort.trim() || undefined,
        audioFormat,
        ffmpegEnabled: ffmpegEnabled && engineCapabilities.postProcessingReady,
        ffmpegLocation: settings.extra.ffmpegPath.trim() || undefined,
        bitrate: convertBitrate,
        outputTemplate,
        playlist: isPlaylist,
        playlistItems: playlistItemsStr || undefined,
        subtitles: downloadSubtitles,
        subtitleLanguages: subtitleLanguages.trim() || undefined,
        autoSubtitles,
        embedSubtitles,
        writeThumbnail,
        embedThumbnail,
        writeInfoJson,
        writeDescription,
        splitChapters,
        sponsorBlock: sponsorBlock.trim() || undefined,
        proxy: mediaProxy.trim() || undefined,
        sourceAddress: configuredSourceAddress || undefined,
        cookies: mediaCookies.trim() || undefined,
        cookiesFromBrowser: cookiesFromBrowser.trim() || undefined,
        userAgent: mediaUserAgent.trim() || undefined,
        referer: mediaReferer.trim() || undefined,
        headers: mediaHeaders.trim() || undefined,
        rateLimitKbs: rateLimitKbs > 0 ? rateLimitKbs : undefined,
        retries: retries > 0 ? retries : undefined,
        fragmentRetries: fragmentRetries > 0 ? fragmentRetries : undefined,
        concurrentFragments: concurrentFragments > 0 ? concurrentFragments : undefined,
        sleepIntervalSec: sleepIntervalSec > 0 ? sleepIntervalSec : undefined,
        maxSleepIntervalSec: maxSleepIntervalSec > 0 ? maxSleepIntervalSec : undefined,
        downloadSections: downloadSections.trim() || undefined,
        matchFilter: matchFilter.trim() || undefined,
        remuxFormat: remuxFormat.trim() || undefined,
      });

      const task = await addTask(
        {
          name: isPlaylist
            ? playlistResult?.title || t('media_playlist_title_fallback')
            : probeResult?.title || t('media_download_title_fallback'),
          url: submittedUrl,
          sizeBytes: selectedFormatSize,
          fileType,
          category: fileType,
          status: 'downloading',
          savePath,
          queueId: selectedQueue,
          description: `Media ${saveMode} request: quality=${quality}, ffmpeg=${ffmpegEnabled ? 'enabled' : 'disabled'}, output=${outputTemplate}`,
          connections: 0,
          resumable: true,
          mediaOptions,
          elapsedSeconds: 0,
        },
        true,
      );

      if (task) {
        cleanupSensitiveLink(submittedUrl);
        setActivePage('downloads');
      }
    } catch (err) {
      addToast(
        'error',
        t('media_engine_unavailable'),
        err instanceof Error ? err.message : t('media_invalid_link_msg'),
      );
    }
  };

  /* ------------------------------ RENDER ------------------------------ */

  return (
    <div className="app-page flex-1 flex flex-col min-h-0 overflow-hidden bg-[var(--bg-app)]" dir="ltr">
      {/* --------------------- HEADER --------------------- */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)] shrink-0 select-none">
        <button type="button" onClick={handleBack} className="toolbar-btn shrink-0" title={t('page_back_tip')}>
          <ArrowLeft className="w-4 h-4" />
          <span className="hidden sm:inline">{t('page_back')}</span>
        </button>

        <div className="h-5 w-px bg-[var(--border-color)] shrink-0" />

        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <Download className="w-4 h-4 text-[var(--danger)] shrink-0" />
          <div className="min-w-0">
            <h1 className="text-sm font-extrabold text-[var(--text-primary)] truncate leading-tight">
              {t('dlg_media_downloader')}
            </h1>
            {probeResult?.title && (
              <p className="text-[10px] text-[var(--text-secondary)] truncate leading-tight">{probeResult.title}</p>
            )}
          </div>
        </div>

        {/* Engine status badges */}
        <div className="hidden md:flex items-center gap-2 shrink-0">
          <span
            className={`flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full border ${
              engineCapabilities.mediaReady
                ? 'text-[var(--success)] bg-[var(--success-bg)] border-[var(--success-border)]'
                : 'text-[var(--danger)] bg-[var(--danger-bg)] border-[var(--danger-border)]'
            }`}
          >
            <Radio className="w-2.5 h-2.5" />
            yt-dlp
          </span>
          <span
            className={`flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full border ${
              ffmpegAvailable
                ? 'text-[var(--success)] bg-[var(--success-bg)] border-[var(--success-border)]'
                : 'text-[var(--text-muted)] bg-[var(--bg-hover)] border-[var(--border-color)]'
            }`}
          >
            <Code className="w-2.5 h-2.5" />
            FFmpeg
          </span>
        </div>
      </div>

      {/* --------------------- ENGINE WARNINGS --------------------- */}
      {(!engineCapabilities.mediaReady || !engineCapabilities.postProcessingReady) && (
        <div className="shrink-0 px-4 pt-2.5 space-y-1.5">
          {!engineCapabilities.mediaReady && (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-[11px] text-[var(--text-primary)]">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {t('media_engine_not_ready')}
            </div>
          )}
          {engineCapabilities.mediaReady && !engineCapabilities.postProcessingReady && (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-bg)] px-3 py-2 text-[11px] text-[var(--text-primary)]">
              <Info className="w-3.5 h-3.5 shrink-0" />
              {t('media_ffmpeg_not_ready')}
            </div>
          )}
        </div>
      )}

      {/* --------------------- BODY: TWO COLUMNS --------------------- */}
      <div className="flex-1 min-h-0 overflow-hidden flex">
        {/* ----------- LEFT PANEL 55% ----------- */}
        <div className="w-[55%] flex flex-col min-h-0 border-r border-[var(--border-color)]/50">
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 scrollbar-thin">
            <div className="space-y-3">
              {/* Save Directory */}
              <div className="space-y-1.5">
                <label className="text-xs font-extrabold text-[var(--text-primary)] flex items-center gap-1.5">
                  <FolderOpen className="w-3.5 h-3.5 text-[var(--warning)]" />
                  {t('media_save_directory')}
                </label>
                <TextField
                  label=""
                  value={savePath}
                  onChange={(e) => {
                    setSavePath(e.target.value);
                  }}
                  placeholder="D:\\Downloads\\Videos"
                  icon={FolderOpen}
                  onIconClick={() => {
                    void (async () => {
                      const picked = await tauriClient.showDirectoryPicker(savePath || undefined);
                      if (picked) setSavePath(picked);
                    })();
                  }}
                  id="page-path"
                />
              </div>

              <EngineStatusBar
                engineCapabilities={engineCapabilities}
                ffmpegAvailable={ffmpegAvailable}
                ffmpegEnabled={ffmpegEnabled}
                onFfmpegEnabledChange={setFfmpegEnabled}
              />

              <div
                className={`p-3 rounded-xl border ${openPanel === 'advanced' ? 'border-[var(--info-border)] bg-[var(--info-bg)]/6' : 'bg-[var(--bg-hover)]/20 border-[var(--border-color)]/30'}`}
              >
                <button
                  type="button"
                  className="w-full text-left flex items-center justify-between"
                  onClick={() => {
                    togglePanel('advanced');
                  }}
                >
                  <div className="flex items-center gap-2">
                    <Settings2 className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                    <span className="text-sm font-extrabold text-[var(--text-primary)]">
                      {t('media_advanced_options')}
                    </span>
                  </div>
                  <ChevronRight
                    className={`w-4 h-4 transition-transform ${openPanel === 'advanced' ? 'rotate-90' : ''}`}
                  />
                </button>
                {openPanel === 'advanced' && (
                  <div className="mt-3 space-y-1.5">
                    <AdvancedTabs
                      advancedTab={advancedTab}
                      onTabChange={setAdvancedTab}
                      state={advancedState}
                      onChange={handleAdvancedChange}
                      supportsMediaOption={engineCapabilities.supportsMediaOption}
                    />
                  </div>
                )}
              </div>

              {/* Left: Collapsible option panels */}
              <div className="space-y-3">
                {/* Mode Toggle Panel */}
                <div
                  className={`p-3 rounded-xl border ${openPanel === 'mode' ? 'border-[var(--danger-border)] bg-[var(--danger-bg)]/6' : 'bg-[var(--bg-hover)]/20 border-[var(--border-color)]/30'}`}
                >
                  <button
                    type="button"
                    className="w-full text-left flex items-center justify-between"
                    onClick={() => {
                      togglePanel('mode');
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <Video className="w-4 h-4" />
                      <span className="text-sm font-extrabold text-[var(--text-primary)]">{t('media_mode')}</span>
                    </div>
                    <ChevronRight
                      className={`w-4 h-4 transition-transform ${openPanel === 'mode' ? 'rotate-90' : ''}`}
                    />
                  </button>
                  {openPanel === 'mode' && (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSaveMode('video');
                          setSavePath(
                            settings.saveAndCategories.categoryFolders.video ||
                              settings.saveAndCategories.defaultFolder ||
                              '',
                          );
                        }}
                        className={`p-3 rounded-xl border text-xs font-extrabold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                          saveMode === 'video'
                            ? 'bg-[var(--danger-bg)] border-[var(--danger-border)] text-[var(--danger)] shadow-[0_0_16px_-4px_var(--danger-bg)]'
                            : 'bg-transparent border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border-color-hover)]'
                        }`}
                      >
                        <Video className="w-4 h-4" />
                        {t('media_video_audio')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSaveMode('audio');
                          setSavePath(
                            settings.saveAndCategories.categoryFolders.audio ||
                              settings.saveAndCategories.defaultFolder ||
                              '',
                          );
                        }}
                        className={`p-3 rounded-xl border text-xs font-extrabold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                          saveMode === 'audio'
                            ? 'bg-[var(--accent-light)] border-[var(--accent-border)] text-[var(--accent-primary)] shadow-[0_0_16px_-4px_var(--accent-glow)]'
                            : 'bg-transparent border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border-color-hover)]'
                        }`}
                      >
                        <Music className="w-4 h-4" />
                        {t('media_audio_only')}
                      </button>
                    </div>
                  )}
                </div>

                {/* Quality Panel */}
                <div
                  className={`p-3 rounded-xl border ${openPanel === 'quality' ? 'border-[var(--danger-border)] bg-[var(--danger-bg)]/6' : 'bg-[var(--bg-hover)]/20 border-[var(--border-color)]/30'}`}
                >
                  <button
                    type="button"
                    className={`w-full text-left flex items-center justify-between ${saveMode === 'audio' || !ytDlpReady ? 'cursor-not-allowed opacity-80' : ''}`}
                    onClick={() => {
                      if (saveMode === 'audio' || !ytDlpReady) return;
                      togglePanel('quality');
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <LayoutGrid className="w-4 h-4" />
                      <span className="text-sm font-extrabold text-[var(--text-primary)]">Video Quality</span>
                    </div>
                    <ChevronRight
                      className={`w-4 h-4 transition-transform ${openPanel === 'quality' ? 'rotate-90' : ''}`}
                    />
                  </button>
                  {openPanel === 'quality' && (
                    <div className="mt-3">
                      {saveMode === 'audio' ? (
                        <div className="rounded-xl border border-[var(--border-color)]/30 bg-[var(--bg-hover)]/50 p-3 text-[12px] text-[var(--text-muted)]">
                          {t('media_quality_disabled_for_audio')}
                        </div>
                      ) : !ytDlpReady ? (
                        <div className="rounded-xl border border-[var(--border-color)]/30 bg-[var(--bg-hover)]/50 p-3 text-[12px] text-[var(--text-muted)]">
                          {t('media_quality_requires_ytdlp')}
                        </div>
                      ) : (
                        <QualityGrid
                          options={dynamicQualityOptions}
                          quality={quality}
                          onQualityChange={(q) => {
                            setQuality(q);
                          }}
                          selectedFormat={selectedFormat}
                          selectedFormatSize={selectedFormatSize}
                          requiresFfmpeg={requiresFfmpeg}
                          ffmpegAvailable={ffmpegAvailable}
                          mediaReady={engineCapabilities.mediaReady}
                          onOpenEnginesSettings={() => {
                            openDialog('settings');
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
                {/* Audio Panel */}
                <div
                  className={`p-3 rounded-xl border ${openPanel === 'audio' ? 'border-[var(--accent-border)] bg-[var(--accent-light)]/6' : 'bg-[var(--bg-hover)]/20 border-[var(--border-color)]/30'}`}
                >
                  <button
                    type="button"
                    className="w-full text-left flex items-center justify-between"
                    onClick={() => {
                      togglePanel('audio');
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <ListMusic className="w-4 h-4" />
                      <span className="text-sm font-extrabold text-[var(--text-primary)]">Audio Format</span>
                    </div>
                    <ChevronRight
                      className={`w-4 h-4 transition-transform ${openPanel === 'audio' ? 'rotate-90' : ''}`}
                    />
                  </button>
                  {openPanel === 'audio' && (
                    <div className="mt-3">
                      {!ytDlpReady ? (
                        <div className="rounded-xl border border-[var(--border-color)]/30 bg-[var(--bg-hover)]/50 p-3 text-[12px] text-[var(--text-muted)]">
                          {t('media_audio_requires_ytdlp')}
                        </div>
                      ) : (
                        <AudioGrid
                          options={dynamicAudioOptions}
                          audioFormat={audioFormat}
                          onAudioFormatChange={setAudioFormat}
                          ffmpegEnabled={ffmpegEnabled}
                          convertBitrate={convertBitrate}
                          onBitrateChange={setConvertBitrate}
                        />
                      )}
                    </div>
                  )}
                </div>

                {/* Output / Naming Panel */}
                <div
                  className={`p-3 rounded-xl border ${openPanel === 'output' ? 'border-[var(--info-border)] bg-[var(--info-bg)]/6' : 'bg-[var(--bg-hover)]/20 border-[var(--border-color)]/30'}`}
                >
                  <button
                    type="button"
                    className="w-full text-left flex items-center justify-between"
                    onClick={() => {
                      togglePanel('output');
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4" />
                      <span className="text-sm font-extrabold text-[var(--text-primary)]">Output Naming</span>
                    </div>
                    <ChevronRight
                      className={`w-4 h-4 transition-transform ${openPanel === 'output' ? 'rotate-90' : ''}`}
                    />
                  </button>
                  {openPanel === 'output' && (
                    <div className="mt-3">
                      <div className="flex gap-1 mb-2">
                        {[
                          { preset: '%(title)s.%(ext)s', label: t('media_preset_title') },
                          { preset: '%(uploader)s - %(title)s.%(ext)s', label: t('media_preset_artist') },
                          { preset: '%(playlist_index)s - %(title)s.%(ext)s', label: t('media_preset_index') },
                        ].map((p) => (
                          <button
                            key={p.preset}
                            type="button"
                            onClick={() => {
                              handleTemplatePreset(p.preset);
                            }}
                            className={`text-[9px] px-1.5 py-0.5 rounded-md transition-all cursor-pointer ${
                              outputTemplate === p.preset
                                ? 'bg-[var(--info-bg)] text-[var(--info)] border border-[var(--info-border)]'
                                : 'bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-transparent'
                            }`}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                      <TextField
                        label=""
                        value={outputTemplate}
                        onChange={(e) => {
                          setOutputTemplate(e.target.value);
                        }}
                        placeholder="%(title)s.%(ext)s"
                        className="font-mono"
                        id="page-template"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ----------- RIGHT PANEL 45% ----------- */}
        <div className="w-[45%] flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 scrollbar-thin">
            <div className="shrink-0 px-4 pt-3 pb-2 space-y-1">
              <div className="flex items-center gap-2.5 px-3 py-2.5 bg-[var(--bg-input)] border border-[var(--border-color)] rounded-xl focus-within:border-[var(--accent-primary)] transition-colors">
                {isProbingAny ? (
                  <Loader2 className="w-4 h-4 text-[var(--accent-primary)] animate-spin shrink-0" />
                ) : (
                  <Globe className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                )}
                <input
                  type="text"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                  }}
                  placeholder={t('media_url_placeholder')}
                  className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none font-mono"
                  style={{ direction: 'ltr' }}
                  id="page-url"
                />
                {isProbingAny && (
                  <span className="text-[10px] text-[var(--text-secondary)] shrink-0 font-medium">
                    {isProbingPlaylist ? t('media_fetching_playlist') : t('media_probing_formats')}
                  </span>
                )}
              </div>
              {probeError && (
                <p className="flex items-center gap-1.5 text-[11px] text-[var(--danger)] px-1">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  {probeError}
                </p>
              )}
              {playlistError && (
                <p className="flex items-center gap-1.5 text-[11px] text-[var(--danger)] px-1">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  {playlistError}
                </p>
              )}
            </div>

            {!isPlaylistUrl && probeResult && (
              <div className="bg-[var(--bg-hover)]/40 border border-[var(--border-color)]/30 rounded-xl p-3">
                <div className="flex items-start gap-3">
                  {probeResult.thumbnail && (
                    <img
                      src={probeResult.thumbnail}
                      alt=""
                      className="w-28 h-[72px] rounded-lg object-cover shrink-0 bg-black/40"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-[var(--text-primary)] line-clamp-2 leading-snug">
                      {probeResult.title}
                    </p>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      {probeResult.duration > 0 && (
                        <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] bg-[var(--bg-hover)] border border-[var(--border-color)] px-1.5 py-0.5 rounded-md">
                          <Clock className="w-2.5 h-2.5" />
                          {formatDuration(probeResult.duration)}
                        </span>
                      )}
                      <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] bg-[var(--bg-hover)] border border-[var(--border-color)] px-1.5 py-0.5 rounded-md">
                        <Film className="w-2.5 h-2.5" />
                        {t('media_formats_count').replace('{count}', String(probeResult.formats.length))}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {isPlaylistUrl && isProbingPlaylist && (
              <div className="flex items-center justify-center gap-2 py-10 text-[var(--text-secondary)] text-sm">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--info)]" />
                {t('media_fetching_entries')}
              </div>
            )}

            {isPlaylistUrl && playlistResult && (
              <PlaylistBrowser
                playlistResult={playlistResult}
                selectAllPlaylist={selectAllPlaylist}
                onSelectAllChange={(v) => {
                  setSelectAllPlaylist(v);
                }}
                selectedItems={selectedPlaylistItems}
                onSelectedItemsChange={setSelectedPlaylistItems}
              />
            )}

            {isPlaylistUrl && playlistResult && totalSize > 0 && (
              <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)] px-1">
                <span>
                  {t('media_per_file')} {selectedFormatSize > 0 ? formatBytes(selectedFormatSize) : '—'}
                </span>
                <span className="text-[var(--info)] font-semibold">
                  {t('media_est_total')} {formatBytes(totalSize)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* --------------------- FOOTER --------------------- */}
      <div className="shrink-0 border-t border-[var(--border-color)] bg-[var(--bg-sidebar)] px-4 py-3 flex items-center justify-between gap-3">
        {/* Left: size info */}
        <div className="flex items-center gap-3 min-w-0">
          {selectedFormatSize > 0 && !isPlaylistUrl && (
            <span className="text-[11px] text-[var(--text-muted)] font-mono flex items-center gap-1">
              <Zap className="w-3 h-3" />
              {formatBytes(selectedFormatSize)}
            </span>
          )}
          {isPlaylistUrl && playlistResult && (
            <span className="text-[11px] text-[var(--text-muted)] flex items-center gap-1">
              <ListMusic className="w-3 h-3" />
              {selectAllPlaylist ? playlistResult.entries.length : selectedPlaylistItems.size}&nbsp;item
              {(selectAllPlaylist ? playlistResult.entries.length : selectedPlaylistItems.size) !== 1 ? 's' : ''}
              {totalSize > 0 && (
                <span className="text-[var(--info)] ml-1 font-semibold">· {formatBytes(totalSize)}</span>
              )}
            </span>
          )}
          {requiresFfmpeg && !ffmpegAvailable && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--warning)]">
              <Info className="w-3 h-3 shrink-0" />
              {t('media_ffmpeg_missing')}
            </span>
          )}
        </div>

        {/* Right: action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleBack}
            className="px-4 py-2 text-xs font-bold text-[var(--text-secondary)] bg-transparent border border-[var(--border-color)] rounded-xl hover:border-[var(--border-color-hover)] hover:text-[var(--text-primary)] transition-all cursor-pointer"
          >
            {t('btn_cancel')}
          </button>

          <button
            type="button"
            onClick={() => void handleStartDownload()}
            disabled={!engineCapabilities.mediaReady || isProbingAny}
            className="flex items-center gap-2 px-5 py-2 text-xs font-extrabold text-white bg-[var(--danger)] hover:bg-[var(--danger)] active:bg-[var(--danger-hover)] disabled:opacity-40 disabled:cursor-not-allowed border border-[var(--danger-border)] rounded-xl shadow-[0_0_20px_-6px_var(--danger)] hover:shadow-[0_0_24px_-4px_var(--danger)] transition-all cursor-pointer"
          >
            {isProbingAny ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            {isPlaylistUrl ? (
              <>
                {t('media_download_playlist')}
                {playlistResult && (
                  <span className="text-[var(--text-primary)]/70 font-semibold">
                    ({selectAllPlaylist ? playlistResult.entries.length : selectedPlaylistItems.size})
                  </span>
                )}
              </>
            ) : (
              t('media_start_download')
            )}
            <ChevronRight className="w-3.5 h-3.5 text-[var(--text-primary)]/50" />
          </button>
        </div>
      </div>
    </div>
  );
};
