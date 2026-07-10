/* src/dialogs/download/MediaDownloadDialog.tsx */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  FolderOpen,
  Music,
  Video,
  Code,
  Download,
  AlertCircle,
  Loader2,
  CheckCircle2,
  XCircle,
  Info,
  CheckSquare,
  Square,
  ListMusic,
  ChevronDown,
  ChevronRight,
  Globe,
  Zap,
  Settings2,
  Shield,
  Subtitles,
} from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { novaClient, type MediaFormat, type MediaPlaylistEntry } from '../../api/novaClient';
import { tauriClient } from '../../api/tauriClient';
import { clearClipboardIfTextMatches } from '../../utils/clipboard';
import { TextField, Switch, DialogButton } from '../../components/primitives';
import { formatBytes } from '../../initialData';
import { useEngineCapabilities } from '../../capabilities/EngineCapabilityContext';

function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${String(h)}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m)}:${String(s).padStart(2, '0')}`;
}

function bestVideoFormat(formats: MediaFormat[], heightLimit?: number): MediaFormat | null {
  const candidates = formats.filter(
    (f) =>
      f.vcodec &&
      f.vcodec !== 'none' &&
      f.height != null &&
      f.height > 0 &&
      (heightLimit ? f.height <= heightLimit : true),
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const h = (b.height || 0) - (a.height || 0);
    if (h !== 0) return h;
    return (b.tbr || 0) - (a.tbr || 0);
  });
  return candidates[0];
}

function resolutionLabel(height: number | null): string {
  if (!height) return 'Unknown';
  if (height >= 4320) return '8K';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '2K';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  if (height >= 360) return '360p';
  if (height >= 240) return '240p';
  return '144p';
}

function resolutionBadgeColor(height: number | null): string {
  if (!height) return 'text-slate-400 bg-slate-500/10 border-slate-500/20';
  if (height >= 2160) return 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20';
  if (height >= 1080) return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
  if (height >= 720) return 'text-blue-400 bg-blue-500/10 border-blue-500/20';
  if (height >= 480) return 'text-slate-300 bg-slate-500/10 border-slate-500/20';
  return 'text-slate-400 bg-slate-500/10 border-slate-500/20';
}

type CollapsibleId = 'ffmpeg' | 'subtitles' | 'network' | 'performance';

export const MediaDownloadDialog: React.FC = () => {
  const { dialog, closeDialog, settings, addTask, addToast, t } = useAppStore();
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

  const [url, setUrl] = useState(() => (typeof dialog.payload === 'string' ? dialog.payload : ''));
  const [savePath, setSavePath] = useState(
    settings.saveAndCategories.categoryFolders.video || settings.saveAndCategories.defaultFolder || '',
  );
  const [targetType, setTargetType] = useState<'video' | 'playlist'>('video');
  const [saveMode, setSaveMode] = useState<'video' | 'audio'>('video');
  const [quality, setQuality] = useState<string>(settings.extra.videoQuality === 'ask' ? 'best' : settings.extra.videoQuality || 'best');
  const [audioFormat, setAudioFormat] = useState<string>('mp3');
  const [selectedQueue] = useState('main');

  const [ffmpegEnabled, setFfmpegEnabled] = useState(true);
  const [convertBitrate, setConvertBitrate] = useState<string>('320k');
  const [outputTemplate, setOutputTemplate] = useState('%(title)s.%(ext)s');
  const [formatSelectorOverride, setFormatSelectorOverride] = useState('');
  const [formatSort, setFormatSort] = useState('');
  const [downloadSubtitles, setDownloadSubtitles] = useState(settings.extra.downloadSubtitles || false);
  const [subtitleLanguages, setSubtitleLanguages] = useState(settings.extra.subtitleLanguage || '');
  const [autoSubtitles, setAutoSubtitles] = useState(false);
  const [embedSubtitles, setEmbedSubtitles] = useState(false);
  const [writeThumbnail, setWriteThumbnail] = useState(false);
  const [embedThumbnail, setEmbedThumbnail] = useState(false);
  const [writeInfoJson, setWriteInfoJson] = useState(false);
  const [writeDescription, setWriteDescription] = useState(false);
  const [splitChapters, setSplitChapters] = useState(false);
  const [sponsorBlock, setSponsorBlock] = useState('');
  const [mediaProxy, setMediaProxy] = useState(buildConfiguredProxy);
  const [mediaCookies, setMediaCookies] = useState('');
  const [cookiesFromBrowser, setCookiesFromBrowser] = useState('');
  const [mediaUserAgent, setMediaUserAgent] = useState(settings.extra.userAgent || '');
  const [mediaReferer, setMediaReferer] = useState('');
  const [mediaHeaders, setMediaHeaders] = useState('');
  const [rateLimitKbs, setRateLimitKbs] = useState<number>(0);
  const [retries, setRetries] = useState<number>(10);
  const [fragmentRetries, setFragmentRetries] = useState<number>(10);
  const [concurrentFragments, setConcurrentFragments] = useState<number>(4);
  const [sleepIntervalSec, setSleepIntervalSec] = useState<number>(0);
  const [maxSleepIntervalSec, setMaxSleepIntervalSec] = useState<number>(0);
  const [downloadSections, setDownloadSections] = useState('');
  const [matchFilter, setMatchFilter] = useState('');
  const [remuxFormat, setRemuxFormat] = useState('');
  const [extraArgs, setExtraArgs] = useState('');

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

  const [playlistResult, setPlaylistResult] = useState<{ title: string; entries: MediaPlaylistEntry[] } | null>(null);
  const [isProbingPlaylist, setIsProbingPlaylist] = useState(false);
  const [playlistError, setPlaylistError] = useState('');
  const [selectedPlaylistItems, setSelectedPlaylistItems] = useState<Set<number>>(new Set());
  const [selectAllPlaylist, setSelectAllPlaylist] = useState(true);

  const [expandedSections, setExpandedSections] = useState<Set<CollapsibleId>>(new Set());
  const toggleSection = (id: CollapsibleId) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestUrlRef = useRef('');

  const isPlaylistUrl = targetType === 'playlist' || url.includes('list=');
  const supportsMediaOption = (key: string) => engineCapabilities.supportsMediaOption(key);

  useEffect(() => {
    latestUrlRef.current = url;
  }, [url]);

  useEffect(() => {
    return () => {
      if (settings.extra.preventClipboardHistory) {
        void clearClipboardIfTextMatches(latestUrlRef.current);
      }
    };
  }, [settings.extra.preventClipboardHistory]);

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
          setPlaylistError(e instanceof Error ? e.message : 'Playlist probe failed');
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
            if (best && best.height) setQuality(`${String(best.height)}p`);
          }
        } catch (e) {
          setProbeError(e instanceof Error ? e.message : 'Probe failed');
          setProbeResult(null);
        } finally {
          setIsProbing(false);
        }
      }
    },
    [isPlaylistUrl],
  );

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
    if (isPlaylistUrl) {
      setProbeResult(null);
    } else {
      setPlaylistResult(null);
    }
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!url.trim().startsWith('http')) {
      return;
    }
    debounceRef.current = setTimeout(() => {
      void doProbe(url);
    }, 800);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [url, doProbe]);

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

  const closeWithoutKeepingLink = () => {
    const currentUrl = latestUrlRef.current;
    clearSensitiveDialogState();
    cleanupSensitiveLink(currentUrl);
    closeDialog();
  };

  const handleStartDownload = async () => {
    const submittedUrl = url.trim();
    if (!submittedUrl || !submittedUrl.startsWith('http')) {
      addToast('error', 'Invalid Link', 'Please enter a valid media URL.');
      return;
    }

    if (!engineCapabilities.mediaReady) {
      addToast('error', 'Media engine unavailable', engineCapabilities.mediaBlockedReason() || 'Media engine is not ready.');
      return;
    }

    if (
      settings.extra.vpnEnabled &&
      settings.extra.vpnKillSwitch &&
      ((settings.extra.vpnMode === 'proxy' && !settings.extra.vpnProxyUrl.trim()) ||
        (settings.extra.vpnMode === 'bind' && !settings.extra.vpnBindAddress.trim()))
    ) {
      addToast('error', 'VPN routing', 'Complete the VPN routing settings before creating a new media download.');
      return;
    }

    const vpnRoute = await tauriClient.validateVpnRoute(settings);
    if (!vpnRoute.ok) {
      addToast('error', 'VPN routing', vpnRoute.message);
      return;
    }

    if (isPlaylistUrl && playlistResult && !selectAllPlaylist && selectedPlaylistItems.size === 0) {
      addToast('error', 'No videos selected', 'Please select at least one video from the playlist.');
      return;
    }

    if (requiresFfmpeg && !engineCapabilities.postProcessingReady) {
      addToast(
        'error',
        'FFmpeg unavailable',
        'The selected media operation requires FFmpeg, but the post-processing engine is not ready.',
      );
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

    const mediaOptions = engineCapabilities.sanitizeMediaOptions({
      mode: saveMode,
      quality,
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
        name: isPlaylist ? playlistResult?.title || 'Media playlist' : probeResult?.title || 'Media download',
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
      },
      true,
    );

    if (task) {
      cleanupSensitiveLink(submittedUrl);
    }
  };

  const isProbingAny = isProbing || isProbingPlaylist;

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

  const dynamicQualityOptions = (() => {
    const options: Array<{
      value: string;
      label: string;
      size: string;
      sizeBytes: number;
      needsFfmpeg: boolean;
      codecInfo: string;
      height: number;
      fps: number;
      ext: string;
      formatNote: string;
      hasAudio: boolean;
      tbr: number;
    }> = [];
    options.push({
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

    if (!probeResult || saveMode !== 'video') return options;

    const sorted = [...probeResult.formats]
      .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height != null && f.height > 0)
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    const seen = new Set<number>();
    for (const fmt of sorted) {
      if (fmt.height == null || seen.has(fmt.height)) continue;
      seen.add(fmt.height);
      const hasAudio = !!(fmt.acodec && fmt.acodec !== 'none');
      const fileSize = fmt.filesize || fmt.filesizeApprox || 0;
      const codec = fmt.vcodec.split('.')[0] || '';
      options.push({
        value: `${String(fmt.height)}p`,
        label: resolutionLabel(fmt.height),
        size: fileSize ? formatBytes(fileSize) : '',
        sizeBytes: fileSize,
        needsFfmpeg: !hasAudio,
        codecInfo: codec,
        height: fmt.height,
        fps: fmt.fps || 0,
        ext: fmt.ext,
        formatNote: fmt.formatNote || '',
        hasAudio,
        tbr: fmt.tbr || 0,
      });
    }
    return options;
  })();

  const dynamicAudioOptions = (() => {
    const options: Array<{
      value: string;
      label: string;
      needsFfmpeg: boolean;
      bitrate: string;
      sizeBytes: number;
      ext: string;
      description: string;
    }> = [
      { value: 'mp3', label: 'MP3', needsFfmpeg: true, bitrate: '320kbps', sizeBytes: 0, ext: 'mp3', description: 'Best Compatibility' },
      { value: 'm4a', label: 'M4A (AAC)', needsFfmpeg: false, bitrate: '', sizeBytes: 0, ext: 'm4a', description: 'Original Quality' },
      { value: 'flac', label: 'FLAC', needsFfmpeg: true, bitrate: '', sizeBytes: 0, ext: 'flac', description: 'Lossless Archive' },
      { value: 'wav', label: 'WAV', needsFfmpeg: true, bitrate: '', sizeBytes: 0, ext: 'wav', description: 'Uncompressed PCM' },
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
          const fileSize = f.filesize || f.filesizeApprox || 0;
          options.push({
            value: key,
            label: f.ext.toUpperCase(),
            needsFfmpeg: false,
            bitrate: abr,
            sizeBytes: fileSize,
            ext: key,
            description: `Original Stream${abr ? ` ${abr}` : ''}`,
          });
        }
      }
    }
    return options;
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
      if (selectAllPlaylist) {
        return selectedFormatSize * playlistResult.entries.length;
      }
      return selectedFormatSize * selectedPlaylistItems.size;
    }
    return selectedFormatSize;
  })();

  const SectionHeader: React.FC<{
    id: CollapsibleId;
    icon: React.ReactNode;
    label: string;
    color: string;
    badge?: string;
  }> = ({ id, icon, label, color, badge }) => {
    const isExpanded = expandedSections.has(id);
    return (
      <button
        type="button"
        onClick={() => toggleSection(id)}
        className={`w-full flex items-center justify-between p-2.5 rounded-lg border border-[var(--border-color)]/40 hover:border-[var(--border-color)] transition-all cursor-pointer bg-[var(--bg-hover)]/20`}
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className={`text-xs font-extrabold ${color}`}>{label}</span>
          {badge && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-500/10 text-slate-400 font-bold">
              {badge}
            </span>
          )}
        </div>
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
        )}
      </button>
    );
  };

  return (
    <div className="space-y-3 text-ui text-left" dir="ltr">
      {!engineCapabilities.mediaReady && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-200">
          Media engine is not ready. Media downloads are disabled until the runtime engine check passes.
        </div>
      )}
      {engineCapabilities.mediaReady && !engineCapabilities.postProcessingReady && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200">
          FFmpeg is not ready. Merging, remuxing, audio extraction, thumbnails, subtitles, and chapter processing are disabled.
        </div>
      )}

      {/* ── URL Input ── */}
      <div className="space-y-1">
        <TextField
          label="Media URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.example.com/watch?v=..."
          icon={isProbingAny ? Loader2 : undefined}
          id="yt-url"
        />
        {isProbingAny && (
          <p className="flex items-center gap-1 text-[10px] text-slate-400">
            <Loader2 className="w-3 h-3 animate-spin" />
            {isProbingPlaylist ? 'Fetching playlist entries...' : 'Fetching available formats...'}
          </p>
        )}
        {probeError && (
          <p className="flex items-center gap-1 text-[10px] text-red-400">
            <AlertCircle className="w-3 h-3" />
            {probeError}
          </p>
        )}
        {playlistError && (
          <p className="flex items-center gap-1 text-[10px] text-red-400">
            <AlertCircle className="w-3 h-3" />
            {playlistError}
          </p>
        )}
      </div>

      {/* ── Video Info Card ── */}
      {!isPlaylistUrl && probeResult && (
        <div className="bg-[var(--bg-hover)]/40 border border-[var(--border-color)]/30 rounded-xl p-3">
          <div className="flex items-start gap-3">
            {probeResult.thumbnail && (
              <img
                src={probeResult.thumbnail}
                alt=""
                className="w-20 h-14 rounded-lg object-cover shrink-0 bg-black/40"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-slate-200 line-clamp-2">{probeResult.title}</p>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {probeResult.duration > 0 && (
                  <span className="text-[10px] text-slate-400 bg-slate-500/10 px-1.5 py-0.5 rounded">
                    {formatDuration(probeResult.duration)}
                  </span>
                )}
                <span className="text-[10px] text-slate-500 bg-slate-500/10 px-1.5 py-0.5 rounded">
                  {probeResult.formats.length} formats
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Playlist Browser ── */}
      {isPlaylistUrl && playlistResult && (
        <div className="bg-[var(--bg-hover)]/40 border border-[var(--border-color)]/30 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between p-3 border-b border-[var(--border-color)]/20">
            <div className="flex items-center gap-2 min-w-0">
              <ListMusic className="w-4 h-4 text-sky-400 shrink-0" />
              <span className="text-xs font-bold text-slate-200 truncate">{playlistResult.title || 'Playlist'}</span>
              <span className="text-[10px] text-slate-500 shrink-0">({playlistResult.entries.length})</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectAllPlaylist(!selectAllPlaylist);
                if (!selectAllPlaylist) setSelectedPlaylistItems(new Set(playlistResult.entries.map((e) => e.index)));
              }}
              className="flex items-center gap-1 text-[10px] text-sky-400 hover:text-sky-300 shrink-0"
            >
              {selectAllPlaylist ? <CheckSquare className="w-3 h-3" /> : <Square className="w-3 h-3" />}
              {selectAllPlaylist ? 'All' : `${String(selectedPlaylistItems.size)} sel.`}
            </button>
          </div>
          <div className="max-h-52 overflow-y-auto divide-y divide-[var(--border-color)]/10 scrollbar-thin">
            {playlistResult.entries.map((entry) => {
              const isSelected = selectAllPlaylist || selectedPlaylistItems.has(entry.index);
              return (
                <div
                  key={entry.id}
                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[var(--bg-hover)]/50 transition-colors ${isSelected ? '' : 'opacity-40'}`}
                  onClick={() => {
                    if (selectAllPlaylist) return;
                    const next = new Set(selectedPlaylistItems);
                    if (next.has(entry.index)) next.delete(entry.index);
                    else next.add(entry.index);
                    setSelectedPlaylistItems(next);
                  }}
                >
                  {selectAllPlaylist ? (
                    <CheckSquare className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : isSelected ? (
                    <CheckSquare className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  ) : (
                    <Square className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  )}
                  <span className="text-[10px] text-slate-500 w-5 shrink-0 text-right font-mono">{entry.index}</span>
                  {entry.thumbnail && (
                    <img
                      src={entry.thumbnail}
                      alt=""
                      className="w-12 h-8 rounded object-cover shrink-0 bg-black/40"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  )}
                  <span className="text-[11px] text-slate-300 truncate min-w-0 flex-1">{entry.title}</span>
                  {entry.duration > 0 && (
                    <span className="text-[10px] text-slate-500 shrink-0 font-mono">{formatDuration(entry.duration)}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Save Directory ── */}
      <TextField
        label="Save Directory"
        value={savePath}
        onChange={(e) => setSavePath(e.target.value)}
        icon={FolderOpen}
        id="yt-path"
      />

      {/* ── Mode Toggle ── */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => {
            setSaveMode('video');
            setSavePath(settings.saveAndCategories.categoryFolders.video || settings.saveAndCategories.defaultFolder || '');
          }}
          className={`p-2.5 rounded-xl border text-xs font-extrabold flex items-center justify-center gap-2 transition-all cursor-pointer ${
            saveMode === 'video'
              ? 'bg-red-500/10 border-red-500/40 text-red-400 shadow-[0_0_12px_-3px_rgba(239,68,68,0.3)]'
              : 'bg-transparent border-[var(--border-color)] text-slate-400 hover:text-slate-200 hover:border-[var(--border-color-hover)]'
          }`}
        >
          <Video className="w-4 h-4" />
          Video & Audio
        </button>
        <button
          type="button"
          onClick={() => {
            setSaveMode('audio');
            setSavePath(settings.saveAndCategories.categoryFolders.audio || settings.saveAndCategories.defaultFolder || '');
          }}
          className={`p-2.5 rounded-xl border text-xs font-extrabold flex items-center justify-center gap-2 transition-all cursor-pointer ${
            saveMode === 'audio'
              ? 'bg-purple-500/10 border-purple-500/40 text-purple-400 shadow-[0_0_12px_-3px_rgba(168,85,247,0.3)]'
              : 'bg-transparent border-[var(--border-color)] text-slate-400 hover:text-slate-200 hover:border-[var(--border-color-hover)]'
          }`}
        >
          <Music className="w-4 h-4" />
          Audio Only
        </button>
      </div>

      {/* ── Quality Picker (Video) ── */}
      {saveMode === 'video' && (
        <div className="space-y-1.5">
          <label className="text-xs font-extrabold text-slate-300">Video Quality</label>
          <div className="grid grid-cols-1 gap-1.5 max-h-56 overflow-y-auto pr-1 scrollbar-thin">
            {dynamicQualityOptions.map((opt) => {
              const isSelected = quality === opt.value;
              const badgeColor = resolutionBadgeColor(opt.height);
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setQuality(opt.value)}
                  className={`w-full flex items-center gap-2.5 p-2.5 rounded-xl border transition-all cursor-pointer text-left ${
                    isSelected
                      ? 'bg-red-500/8 border-red-500/30 shadow-[0_0_8px_-2px_rgba(239,68,68,0.2)]'
                      : 'bg-[var(--bg-hover)]/20 border-[var(--border-color)]/30 hover:border-[var(--border-color)] hover:bg-[var(--bg-hover)]/40'
                  }`}
                >
                  {opt.value === 'best' ? (
                    <span className="w-14 text-center text-[10px] font-extrabold text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg py-1 shrink-0">
                      BEST
                    </span>
                  ) : (
                    <span className={`w-14 text-center text-[10px] font-extrabold rounded-lg py-1 border shrink-0 ${badgeColor}`}>
                      {opt.label}
                    </span>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      {opt.codecInfo && (
                        <span className="text-[10px] text-slate-400 font-mono">{opt.codecInfo}</span>
                      )}
                      {opt.ext && (
                        <span className="text-[9px] text-slate-500 uppercase font-bold">{opt.ext}</span>
                      )}
                      {opt.fps >= 60 && (
                        <span className="text-[9px] text-amber-400 font-bold">{opt.fps}fps</span>
                      )}
                      {opt.hasAudio ? (
                        <span className="text-[9px] text-emerald-400 font-bold">Muxed</span>
                      ) : opt.value !== 'best' ? (
                        <span className="text-[9px] text-amber-400 font-bold">Needs FFmpeg</span>
                      ) : null}
                    </div>
                    {opt.formatNote && (
                      <span className="text-[9px] text-slate-500 truncate block">{opt.formatNote}</span>
                    )}
                  </div>
                  {opt.size && (
                    <span className="text-[10px] text-slate-400 shrink-0 font-mono">{opt.size}</span>
                  )}
                  {isSelected && <CheckCircle2 className="w-4 h-4 text-red-400 shrink-0" />}
                </button>
              );
            })}
          </div>
          {selectedFormatSize > 0 && (
            <div className="flex items-center justify-between text-[10px] text-slate-400 pt-0.5">
              <span>Per file: {formatBytes(selectedFormatSize)}{selectedFormat?.tbr ? ` @ ${selectedFormat.tbr.toFixed(0)}kbps` : ''}</span>
              {totalSize > 0 && isPlaylistUrl && playlistResult && (
                <span className="text-sky-400 font-semibold">Total: {formatBytes(totalSize)}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Audio Format Picker ── */}
      {saveMode === 'audio' && (
        <div className="space-y-1.5">
          <label className="text-xs font-extrabold text-slate-300">Audio Format</label>
          <div className="grid grid-cols-2 gap-1.5">
            {dynamicAudioOptions.map((opt) => {
              const isSelected = audioFormat === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setAudioFormat(opt.value)}
                  className={`p-2.5 rounded-xl border transition-all cursor-pointer text-left ${
                    isSelected
                      ? 'bg-purple-500/8 border-purple-500/30 shadow-[0_0_8px_-2px_rgba(168,85,247,0.2)]'
                      : 'bg-[var(--bg-hover)]/20 border-[var(--border-color)]/30 hover:border-[var(--border-color)] hover:bg-[var(--bg-hover)]/40'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-extrabold text-slate-200">{opt.label}</span>
                    {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-purple-400" />}
                  </div>
                  <span className="text-[10px] text-slate-400 block mt-0.5">{opt.description}</span>
                  {opt.bitrate && (
                    <span className="text-[9px] text-slate-500 font-mono block mt-0.5">{opt.bitrate}</span>
                  )}
                  {opt.sizeBytes > 0 && (
                    <span className="text-[9px] text-slate-500 font-mono block mt-0.5">{formatBytes(opt.sizeBytes)}</span>
                  )}
                  {opt.needsFfmpeg && (
                    <span className="text-[9px] text-amber-400 font-bold block mt-0.5">Needs FFmpeg</span>
                  )}
                </button>
              );
            })}
          </div>
          {ffmpegEnabled && saveMode === 'audio' && (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[10px] text-slate-400 font-bold">Bitrate:</span>
              <select
                value={convertBitrate}
                onChange={(e) => setConvertBitrate(e.target.value)}
                className="text-[11px] font-semibold bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg px-2 py-1 text-slate-200 focus:outline-none"
                id="yt-bitrate"
              >
                <option value="320k">320 kbps</option>
                <option value="256k">256 kbps</option>
                <option value="192k">192 kbps</option>
                <option value="128k">128 kbps</option>
              </select>
            </div>
          )}
        </div>
      )}

      {/* ── Target Type (only when playlist URL detected) ── */}
      {isPlaylistUrl && (
        <div className="flex items-center gap-2 p-2 bg-[var(--bg-hover)]/20 rounded-lg border border-[var(--border-color)]/30">
          <label className="text-[11px] font-bold text-slate-300 shrink-0">Target:</label>
          <select
            value={targetType}
            onChange={(e) => setTargetType(e.target.value as 'video' | 'playlist')}
            className="flex-1 text-[11px] font-semibold bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none"
            id="yt-target-type"
          >
            <option value="video">Single Video</option>
            <option value="playlist">Full Playlist</option>
          </select>
        </div>
      )}

      {/* ── Output Template ── */}
      <div className="space-y-1.5">
        <div className="flex justify-between items-center">
          <span className="text-xs font-extrabold text-slate-300">Output Naming</span>
          <div className="flex gap-1">
            {[
              { preset: '%(title)s.%(ext)s', label: 'Title' },
              { preset: '%(uploader)s - %(title)s.%(ext)s', label: 'Artist' },
              { preset: '%(playlist_index)s - %(title)s.%(ext)s', label: 'Index' },
            ].map((p) => (
              <button
                key={p.preset}
                type="button"
                onClick={() => handleTemplatePreset(p.preset)}
                className={`text-[9px] px-1.5 py-0.5 rounded transition-all ${
                  outputTemplate === p.preset
                    ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20'
                    : 'bg-[var(--bg-hover)] text-slate-400 hover:text-slate-200 border border-transparent'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <TextField
          label=""
          value={outputTemplate}
          onChange={(e) => setOutputTemplate(e.target.value)}
          placeholder="%(title)s.%(ext)s"
          id="yt-template"
        />
      </div>

      {/* ── FFmpeg Status Bar ── */}
      <div className="flex items-center justify-between p-2.5 bg-[var(--bg-hover)]/20 border border-[var(--border-color)]/30 rounded-xl">
        <div className="flex items-center gap-2">
          <Code
            className={`w-4 h-4 ${ffmpegAvailable === null ? 'text-slate-400' : ffmpegAvailable ? 'text-emerald-400' : 'text-red-400'}`}
          />
          <div>
            <span className="text-[11px] font-bold text-slate-200 block">FFmpeg</span>
            {ffmpegAvailable === null ? (
              <span className="text-[9px] text-slate-400 flex items-center gap-1">
                <Loader2 className="w-2.5 h-2.5 animate-spin" /> Checking...
              </span>
            ) : ffmpegAvailable ? (
              <span className="text-[9px] text-emerald-400">Ready</span>
            ) : (
              <span className="text-[9px] text-red-400">Not detected</span>
            )}
          </div>
        </div>
        <Switch label="" checked={ffmpegEnabled && !!ffmpegAvailable} onChange={setFfmpegEnabled} id="yt-ffmpeg" />
      </div>

      {requiresFfmpeg && ffmpegAvailable && (
        <div className="flex items-start gap-1.5 text-[10px] text-amber-400 px-1">
          <Info className="w-3 h-3 mt-0.5 shrink-0" />
          <span>This quality requires FFmpeg for merging video+audio streams.</span>
        </div>
      )}

      {/* ── Advanced: Subtitles & Metadata ── */}
      <SectionHeader
        id="subtitles"
        icon={<Subtitles className="w-4 h-4 text-blue-400" />}
        label="Subtitles & Metadata"
        color="text-blue-400"
        badge={downloadSubtitles ? 'ON' : undefined}
      />
      {expandedSections.has('subtitles') && (
        <div className="space-y-2 pl-1 animate-in slide-in-from-top-1 duration-150">
          <div className="grid grid-cols-2 gap-2">
            <Switch label="Subtitles" checked={downloadSubtitles} onChange={setDownloadSubtitles} />
            <Switch label="Auto-gen subs" checked={autoSubtitles} onChange={setAutoSubtitles} />
            <Switch label="Embed subs" checked={embedSubtitles} onChange={setEmbedSubtitles} />
            <Switch label="Thumbnail" checked={writeThumbnail} onChange={setWriteThumbnail} />
            <Switch label="Embed thumb" checked={embedThumbnail} onChange={setEmbedThumbnail} />
            <Switch label="Info JSON" checked={writeInfoJson} onChange={setWriteInfoJson} />
            <Switch label="Description" checked={writeDescription} onChange={setWriteDescription} />
            <Switch label="Split chapters" checked={splitChapters} onChange={setSplitChapters} />
          </div>
          <TextField
            label="Subtitle Languages"
            value={subtitleLanguages}
            onChange={(e) => setSubtitleLanguages(e.target.value)}
            placeholder="en,ar,all"
            className="font-mono"
            style={{ direction: 'ltr', textAlign: 'left' }}
          />
        </div>
      )}

      {/* ── Advanced: FFmpeg & Format ── */}
      <SectionHeader
        id="ffmpeg"
        icon={<Settings2 className="w-4 h-4 text-purple-400" />}
        label="Format & Post-processing"
        color="text-purple-400"
      />
      {expandedSections.has('ffmpeg') && (
        <div className="space-y-2 pl-1 animate-in slide-in-from-top-1 duration-150">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <TextField
              label="Format Selector"
              disabled={!supportsMediaOption('formatSelector')}
              value={formatSelectorOverride}
              onChange={(e) => setFormatSelectorOverride(e.target.value)}
              placeholder="bestvideo+bestaudio/best"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Format Sorting"
              disabled={!supportsMediaOption('formatSort')}
              value={formatSort}
              onChange={(e) => setFormatSort(e.target.value)}
              placeholder="res,codec:avc:m4a"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Download Sections"
              disabled={!supportsMediaOption('downloadSections')}
              value={downloadSections}
              onChange={(e) => setDownloadSections(e.target.value)}
              placeholder="*00:01:00-00:03:00"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Match Filter"
              disabled={!supportsMediaOption('matchFilter')}
              value={matchFilter}
              onChange={(e) => setMatchFilter(e.target.value)}
              placeholder="duration < 3600"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Remux Format"
              disabled={!supportsMediaOption('remuxFormat')}
              value={remuxFormat}
              onChange={(e) => setRemuxFormat(e.target.value)}
              placeholder="mp4, mkv, webm"
            />
            <TextField
              label="SponsorBlock"
              disabled={!supportsMediaOption('sponsorBlock')}
              value={sponsorBlock}
              onChange={(e) => setSponsorBlock(e.target.value)}
              placeholder="sponsor,selfpromo"
            />
          </div>
        </div>
      )}

      {/* ── Advanced: Network & Auth ── */}
      <SectionHeader
        id="network"
        icon={<Globe className="w-4 h-4 text-cyan-400" />}
        label="Network & Authentication"
        color="text-cyan-400"
      />
      {expandedSections.has('network') && (
        <div className="space-y-2 pl-1 animate-in slide-in-from-top-1 duration-150">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <TextField
              label="Proxy"
              disabled={!supportsMediaOption('proxy')}
              value={mediaProxy}
              onChange={(e) => setMediaProxy(e.target.value)}
              placeholder="http://127.0.0.1:8080"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Cookies From Browser"
              disabled={!supportsMediaOption('cookiesFromBrowser')}
              value={cookiesFromBrowser}
              onChange={(e) => setCookiesFromBrowser(e.target.value)}
              placeholder="chrome, edge, firefox"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="User-Agent"
              disabled={!supportsMediaOption('userAgent')}
              value={mediaUserAgent}
              onChange={(e) => setMediaUserAgent(e.target.value)}
              placeholder="Mozilla/5.0 ..."
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Referer"
              disabled={!supportsMediaOption('referer')}
              value={mediaReferer}
              onChange={(e) => setMediaReferer(e.target.value)}
              placeholder="https://example.com/page"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">Custom Headers</label>
              <textarea
                rows={2}
                value={mediaHeaders}
                onChange={(e) => setMediaHeaders(e.target.value)}
                placeholder="Header-Name: value"
                className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
                style={{ direction: 'ltr' }}
                disabled={!supportsMediaOption('headers')}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">Cookies</label>
              <textarea
                rows={2}
                value={mediaCookies}
                onChange={(e) => setMediaCookies(e.target.value)}
                placeholder="name=value  or  C:\\path\\cookies.txt"
                className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
                style={{ direction: 'ltr' }}
                disabled={!supportsMediaOption('cookies')}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Advanced: Performance Tuning ── */}
      <SectionHeader
        id="performance"
        icon={<Zap className="w-4 h-4 text-amber-400" />}
        label="Performance Tuning"
        color="text-amber-400"
      />
      {expandedSections.has('performance') && (
        <div className="space-y-2 pl-1 animate-in slide-in-from-top-1 duration-150">
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
            <TextField
              label="Rate Limit"
              disabled={!supportsMediaOption('rateLimitKbs')}
              type="number"
              value={rateLimitKbs}
              onChange={(e) => setRateLimitKbs(Number(e.target.value))}
              placeholder="KB/s"
            />
            <TextField
              label="Retries"
              disabled={!supportsMediaOption('retries')}
              type="number"
              value={retries}
              onChange={(e) => setRetries(Number(e.target.value))}
            />
            <TextField
              label="Frag. Retries"
              disabled={!supportsMediaOption('fragmentRetries')}
              type="number"
              value={fragmentRetries}
              onChange={(e) => setFragmentRetries(Number(e.target.value))}
            />
            <TextField
              label="Fragments"
              disabled={!supportsMediaOption('concurrentFragments')}
              type="number"
              value={concurrentFragments}
              onChange={(e) => setConcurrentFragments(Number(e.target.value))}
            />
            <TextField
              label="Sleep"
              disabled={!supportsMediaOption('sleepIntervalSec')}
              type="number"
              value={sleepIntervalSec}
              onChange={(e) => setSleepIntervalSec(Number(e.target.value))}
              placeholder="sec"
            />
            <TextField
              label="Max Sleep"
              disabled={!supportsMediaOption('maxSleepIntervalSec')}
              type="number"
              value={maxSleepIntervalSec}
              onChange={(e) => setMaxSleepIntervalSec(Number(e.target.value))}
              placeholder="sec"
            />
          </div>
        </div>
      )}

      {/* ── Buttons ── */}
      <div className="flex justify-end gap-2 border-t border-[var(--border-color)] pt-3 mt-1">
        <DialogButton onClick={closeWithoutKeepingLink} variant="ghost">
          {t('btn_cancel')}
        </DialogButton>
        <DialogButton
          onClick={() => void handleStartDownload()}
          variant="primary"
          disabled={!engineCapabilities.mediaReady || (requiresFfmpeg && !engineCapabilities.postProcessingReady)}
          className="flex items-center gap-1.5 font-bold bg-red-600 hover:bg-red-700"
        >
          <Download className="w-3.5 h-3.5" />
          {isPlaylistUrl ? 'Download Playlist' : 'Start Download'}
        </DialogButton>
      </div>
    </div>
  );
};
