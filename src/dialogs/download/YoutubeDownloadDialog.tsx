/* src/dialogs/download/YoutubeDownloadDialog.tsx */
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
} from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { novaClient, type YtDlpFormat, type YtDlpPlaylistEntry } from '../../api/novaClient';
import { clearClipboardIfTextMatches } from '../../utils/clipboard';
import { TextField, Switch, DialogButton } from '../../components/primitives';
import { formatBytes } from '../../initialData';

function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${String(h)}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m)}:${String(s).padStart(2, '0')}`;
}

function bestVideoFormat(formats: YtDlpFormat[], heightLimit?: number): YtDlpFormat | null {
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

export const YoutubeDownloadDialog: React.FC = () => {
  const { dialog, closeDialog, settings, addTask, addToast, t } = useAppStore();

  const [url, setUrl] = useState(() => (typeof dialog.payload === 'string' ? dialog.payload : ''));
  const [savePath, setSavePath] = useState(
    settings.saveAndCategories.categoryFolders.video || settings.saveAndCategories.defaultFolder || '',
  );
  const [targetType, setTargetType] = useState<'video' | 'playlist'>('video');
  const [saveMode, setSaveMode] = useState<'video' | 'audio'>('video');
  const [quality, setQuality] = useState<string>('best');
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
  const [mediaProxy, setMediaProxy] = useState('');
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
    formats: YtDlpFormat[];
  } | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [probeError, setProbeError] = useState('');
  const [ffmpegAvailable, setFfmpegAvailable] = useState<boolean | null>(null);

  const [playlistResult, setPlaylistResult] = useState<{ title: string; entries: YtDlpPlaylistEntry[] } | null>(null);
  const [isProbingPlaylist, setIsProbingPlaylist] = useState(false);
  const [playlistError, setPlaylistError] = useState('');
  const [selectedPlaylistItems, setSelectedPlaylistItems] = useState<Set<number>>(new Set());
  const [selectAllPlaylist, setSelectAllPlaylist] = useState(true);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestUrlRef = useRef('');

  const isPlaylistUrl = targetType === 'playlist' || url.includes('list=');

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
    novaClient
      .checkFfmpeg()
      .then((r) => {
        setFfmpegAvailable(r.available);
      })
      .catch(() => {
        setFfmpegAvailable(false);
      });
  }, []);

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

  // Clear probe results when the URL becomes invalid or the playlist mode
  // flips, adjusting state during render instead of in effects.
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

    if (isPlaylistUrl && playlistResult && !selectAllPlaylist && selectedPlaylistItems.size === 0) {
      addToast('error', 'No videos selected', 'Please select at least one video from the playlist.');
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
        mediaOptions: {
          mode: saveMode,
          quality,
          formatSelector: formatSelectorOverride.trim() || undefined,
          formatSort: formatSort.trim() || undefined,
          audioFormat,
          ffmpegEnabled,
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
          extraArgs: extraArgs.trim() || undefined,
        },
      },
      true,
    );

    if (task) {
      clearSensitiveDialogState();
      cleanupSensitiveLink(submittedUrl);
      closeDialog();
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
    }> = [];
    options.push({
      value: 'best',
      label: 'Best Quality Available (Recommended)',
      size: '',
      sizeBytes: 0,
      needsFfmpeg: true,
      codecInfo: '',
    });

    if (!probeResult || saveMode !== 'video') return options;

    const sorted = [...probeResult.formats]
      .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height != null && f.height > 0)
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    const seen = new Set<number>();
    for (const fmt of sorted) {
      if (fmt.height == null || seen.has(fmt.height)) continue;
      seen.add(fmt.height);
      const hasAudio = fmt.acodec && fmt.acodec !== 'none';
      const fileSize = fmt.filesize || fmt.filesizeApprox || 0;
      const fpsLabel = fmt.fps && fmt.fps >= 60 ? '60fps' : '';
      const codec = fmt.vcodec.split('.')[0] || '';
      options.push({
        value: `${String(fmt.height)}p`,
        label: `${resolutionLabel(fmt.height)} ${fpsLabel} - ${fmt.ext.toUpperCase()} ${fmt.formatNote || ''}${fileSize ? ` [${formatBytes(fileSize)}]` : ''}`,
        size: fileSize ? formatBytes(fileSize) : '',
        sizeBytes: fileSize,
        needsFfmpeg: !hasAudio,
        codecInfo: codec,
      });
    }
    return options;
  })();

  const dynamicAudioOptions = (() => {
    const options: Array<{ value: string; label: string; needsFfmpeg: boolean; bitrate: string; sizeBytes: number }> =
      [];
    options.push({
      value: 'mp3',
      label: 'MP3 (Best Compatibility)',
      needsFfmpeg: true,
      bitrate: '320kbps',
      sizeBytes: 0,
    });
    options.push({
      value: 'm4a',
      label: 'M4A (AAC - Original Quality)',
      needsFfmpeg: false,
      bitrate: '',
      sizeBytes: 0,
    });
    options.push({ value: 'flac', label: 'FLAC (Lossless Archive)', needsFfmpeg: true, bitrate: '', sizeBytes: 0 });
    options.push({ value: 'wav', label: 'WAV (Uncompressed PCM)', needsFfmpeg: true, bitrate: '', sizeBytes: 0 });

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
          const abr = f.abr ? ` ${f.abr.toFixed(0)}kbps` : '';
          const fileSize = f.filesize || f.filesizeApprox || 0;
          options.push({
            value: key,
            label: `${f.ext.toUpperCase()} (Original Stream${abr})${fileSize ? ` [${formatBytes(fileSize)}]` : ''}`,
            needsFfmpeg: false,
            bitrate: abr.trim(),
            sizeBytes: fileSize,
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

  return (
    <div className="space-y-4 text-ui text-left" dir="ltr">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Video className="w-5 h-5 text-red-500" />
        <h2 className="text-sm font-extrabold text-slate-200">Media Downloader</h2>
      </div>

      <div className="space-y-3">
        {/* URL Input with probing */}
        <div className="space-y-1">
          <TextField
            label="Media URL (Video or Playlist URL)"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
            }}
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

        {/* Video Info / Playlist Banner */}
        {!isPlaylistUrl && probeResult && (
          <div className="bg-[var(--bg-hover)]/40 border border-[var(--border-color)]/30 rounded-lg p-2.5">
            <div className="flex items-start gap-2.5">
              {probeResult.thumbnail && (
                <img
                  src={probeResult.thumbnail}
                  alt=""
                  className="w-14 h-10 rounded object-cover shrink-0 bg-black/40"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              )}
              <div className="min-w-0">
                <p className="text-xs font-bold text-slate-200 truncate">{probeResult.title}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  {probeResult.duration > 0 && (
                    <span className="text-[10px] text-slate-400">{formatDuration(probeResult.duration)}</span>
                  )}
                  <span className="text-[10px] text-slate-500">{probeResult.formats.length} formats</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Playlist browser */}
        {isPlaylistUrl && playlistResult && (
          <div className="bg-[var(--bg-hover)]/40 border border-[var(--border-color)]/30 rounded-lg">
            <div className="flex items-center justify-between p-2.5 border-b border-[var(--border-color)]/20">
              <div className="flex items-center gap-2">
                <ListMusic className="w-4 h-4 text-sky-400" />
                <span className="text-xs font-bold text-slate-200 truncate">{playlistResult.title || 'Playlist'}</span>
                <span className="text-[10px] text-slate-500">({playlistResult.entries.length} videos)</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectAllPlaylist(!selectAllPlaylist);
                  if (!selectAllPlaylist) setSelectedPlaylistItems(new Set(playlistResult.entries.map((e) => e.index)));
                }}
                className="flex items-center gap-1 text-[10px] text-sky-400 hover:text-sky-300"
              >
                {selectAllPlaylist ? <CheckSquare className="w-3 h-3" /> : <Square className="w-3 h-3" />}
                {selectAllPlaylist ? 'All selected' : `Selected ${String(selectedPlaylistItems.size)}`}
              </button>
            </div>
            <div className="max-h-48 overflow-y-auto divide-y divide-[var(--border-color)]/10">
              {playlistResult.entries.map((entry) => {
                const isSelected = selectAllPlaylist || selectedPlaylistItems.has(entry.index);
                return (
                  <div
                    key={entry.id}
                    className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-[var(--bg-hover)]/50 ${isSelected ? '' : 'opacity-50'}`}
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
                    <span className="text-[10px] text-slate-500 w-5 shrink-0 text-right">{entry.index}.</span>
                    {entry.thumbnail && (
                      <img
                        src={entry.thumbnail}
                        alt=""
                        className="w-10 h-7 rounded object-cover shrink-0 bg-black/40"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    )}
                    <span className="text-[11px] text-slate-300 truncate min-w-0">{entry.title}</span>
                    {entry.duration > 0 && (
                      <span className="text-[10px] text-slate-500 shrink-0">{formatDuration(entry.duration)}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Row: Save Path & Target Type */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <TextField
            label="Save Directory"
            value={savePath}
            onChange={(e) => {
              setSavePath(e.target.value);
            }}
            icon={FolderOpen}
            id="yt-path"
          />
          <div className="space-y-1">
            <label className="text-xs font-extrabold text-slate-300">Target Content Type</label>
            <select
              value={targetType}
              onChange={(e) => {
                setTargetType(e.target.value as 'video' | 'playlist');
              }}
              className="w-full text-xs font-semibold bg-[var(--bg-input)] border border-[var(--border-color)] hover:border-[var(--border-color-hover)] rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-[var(--accent-primary)]"
              id="yt-target-type"
            >
              <option value="video">Single Video</option>
              <option value="playlist">Full Playlist</option>
            </select>
          </div>
        </div>

        {/* Row: Save Mode & Quality */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 border-t border-[var(--border-color)]/50 pt-3">
          <div className="space-y-1">
            <label className="text-xs font-extrabold text-slate-300">Save Mode</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setSaveMode('video');
                  setSavePath(
                    settings.saveAndCategories.categoryFolders.video || settings.saveAndCategories.defaultFolder || '',
                  );
                }}
                className={`p-2 rounded-lg border text-xs font-extrabold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  saveMode === 'video'
                    ? 'bg-red-500/10 border-red-500/40 text-red-400'
                    : 'bg-transparent border-[var(--border-color)] text-slate-400 hover:text-slate-200'
                }`}
              >
                <Video className="w-4 h-4" />
                Video & Audio
              </button>
              <button
                type="button"
                onClick={() => {
                  setSaveMode('audio');
                  setSavePath(
                    settings.saveAndCategories.categoryFolders.audio || settings.saveAndCategories.defaultFolder || '',
                  );
                }}
                className={`p-2 rounded-lg border text-xs font-extrabold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                  saveMode === 'audio'
                    ? 'bg-red-500/10 border-red-500/40 text-red-400'
                    : 'bg-transparent border-[var(--border-color)] text-slate-400 hover:text-slate-200'
                }`}
              >
                <Music className="w-4 h-4" />
                Audio Only
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-extrabold text-slate-300">
              {saveMode === 'video' ? 'Video Quality' : 'Audio Format'}
            </label>
            {saveMode === 'video' ? (
              <select
                value={quality}
                onChange={(e) => {
                  setQuality(e.target.value);
                }}
                className="w-full text-xs font-semibold bg-[var(--bg-input)] border border-[var(--border-color)] hover:border-[var(--border-color-hover)] rounded-lg p-2.5 text-slate-200 focus:outline-none"
                id="yt-quality"
              >
                {dynamicQualityOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                    {opt.needsFfmpeg ? ' *needs FFmpeg' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={audioFormat}
                onChange={(e) => {
                  setAudioFormat(e.target.value);
                }}
                className="w-full text-xs font-semibold bg-[var(--bg-input)] border border-[var(--border-color)] hover:border-[var(--border-color-hover)] rounded-lg p-2.5 text-slate-200 focus:outline-none"
                id="yt-audio-format"
              >
                {dynamicAudioOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                    {opt.needsFfmpeg ? ' *needs FFmpeg' : ''}
                  </option>
                ))}
              </select>
            )}
            <div className="flex items-center justify-between mt-1">
              {selectedFormatSize > 0 && (
                <span className="text-[10px] text-slate-400">
                  Per file: {formatBytes(selectedFormatSize)}
                  {selectedFormat?.tbr ? ` @ ${selectedFormat.tbr.toFixed(0)}kbps` : ''}
                </span>
              )}
              {totalSize > 0 && (isPlaylistUrl ? playlistResult : false) && (
                <span className="text-[10px] text-sky-400 font-semibold">Total: {formatBytes(totalSize)}</span>
              )}
            </div>
          </div>
        </div>

        {/* FFmpeg Status & Config */}
        <div className="p-3 bg-[var(--bg-hover)]/30 border border-[var(--border-color)]/40 rounded-lg space-y-2.5 border-t border-[var(--border-color)]/50">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="text-xs font-extrabold text-slate-200 flex items-center gap-1.5">
                <Code
                  className={`w-4 h-4 ${ffmpegAvailable === null ? 'text-slate-400' : ffmpegAvailable ? 'text-emerald-400' : 'text-red-400'}`}
                />
                FFmpeg Post-processing
              </span>
              <div className="flex items-center gap-1.5">
                {ffmpegAvailable === null ? (
                  <span className="text-[10px] text-slate-400 flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Checking availability...
                  </span>
                ) : ffmpegAvailable ? (
                  <span className="text-[10px] text-emerald-400 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    FFmpeg is installed and ready
                  </span>
                ) : (
                  <span className="text-[10px] text-red-400 flex items-center gap-1">
                    <XCircle className="w-3 h-3" />
                    FFmpeg not detected
                  </span>
                )}
              </div>
            </div>
            <Switch label="" checked={ffmpegEnabled && !!ffmpegAvailable} onChange={setFfmpegEnabled} id="yt-ffmpeg" />
          </div>

          {requiresFfmpeg && ffmpegAvailable && (
            <div className="flex items-start gap-1.5 text-[10px] text-amber-400">
              <Info className="w-3 h-3 mt-0.5 shrink-0" />
              <span>This quality requires FFmpeg for merging video+audio streams.</span>
            </div>
          )}

          {ffmpegEnabled && saveMode === 'audio' && (
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-bold">Audio Bitrate</span>
                <select
                  value={convertBitrate}
                  onChange={(e) => {
                    setConvertBitrate(e.target.value);
                  }}
                  className="w-full text-[11px] font-semibold bg-[var(--bg-input)] border border-[var(--border-color)] rounded p-1.5 text-slate-200 focus:outline-none"
                  id="yt-bitrate"
                >
                  <option value="320k">320 kbps (High Quality)</option>
                  <option value="256k">256 kbps (Medium High)</option>
                  <option value="192k">192 kbps (Standard)</option>
                  <option value="128k">128 kbps (Optimized Size)</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Output Template */}
        <div className="space-y-2 border-t border-[var(--border-color)]/50 pt-3">
          <div className="flex justify-between items-center">
            <span className="text-xs font-extrabold text-slate-300">Output Naming Template</span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => {
                  handleTemplatePreset('%(title)s.%(ext)s');
                }}
                className="text-[9px] bg-[var(--bg-hover)] hover:bg-[var(--border-color)] text-slate-400 hover:text-slate-200 px-1.5 py-1 rounded"
              >
                Video Title
              </button>
              <button
                type="button"
                onClick={() => {
                  handleTemplatePreset('%(uploader)s - %(title)s.%(ext)s');
                }}
                className="text-[9px] bg-[var(--bg-hover)] hover:bg-[var(--border-color)] text-slate-400 hover:text-slate-200 px-1.5 py-1 rounded"
              >
                Uploader - Title
              </button>
              <button
                type="button"
                onClick={() => {
                  handleTemplatePreset('%(playlist_index)s - %(title)s.%(ext)s');
                }}
                className="text-[9px] bg-[var(--bg-hover)] hover:bg-[var(--border-color)] text-slate-400 hover:text-slate-200 px-1.5 py-1 rounded"
              >
                Playlist Index
              </button>
            </div>
          </div>
          <TextField
            label=""
            value={outputTemplate}
            onChange={(e) => {
              setOutputTemplate(e.target.value);
            }}
            placeholder="%(title)s.%(ext)s"
            id="yt-template"
          />
        </div>

        <div className="space-y-3 border-t border-[var(--border-color)]/50 pt-3">
          <span className="text-xs font-extrabold text-slate-300">Advanced Media Options</span>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <TextField
              label="Format Selector Override"
              value={formatSelectorOverride}
              onChange={(e) => {
                setFormatSelectorOverride(e.target.value);
              }}
              placeholder="bestvideo+bestaudio/best"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Format Sorting"
              value={formatSort}
              onChange={(e) => {
                setFormatSort(e.target.value);
              }}
              placeholder="res,codec:avc:m4a"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Download Sections"
              value={downloadSections}
              onChange={(e) => {
                setDownloadSections(e.target.value);
              }}
              placeholder="*00:01:00-00:03:00"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Match Filter"
              value={matchFilter}
              onChange={(e) => {
                setMatchFilter(e.target.value);
              }}
              placeholder="duration < 3600"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Remux Format"
              value={remuxFormat}
              onChange={(e) => {
                setRemuxFormat(e.target.value);
              }}
              placeholder="mp4, mkv, webm"
            />
            <TextField
              label="Sponsor Segment Removal"
              value={sponsorBlock}
              onChange={(e) => {
                setSponsorBlock(e.target.value);
              }}
              placeholder="sponsor,selfpromo"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Switch label="Download subtitles" checked={downloadSubtitles} onChange={setDownloadSubtitles} />
            <Switch label="Download auto-generated subtitles" checked={autoSubtitles} onChange={setAutoSubtitles} />
            <Switch label="Embed subtitles when possible" checked={embedSubtitles} onChange={setEmbedSubtitles} />
            <Switch label="Write thumbnail file" checked={writeThumbnail} onChange={setWriteThumbnail} />
            <Switch label="Embed thumbnail when possible" checked={embedThumbnail} onChange={setEmbedThumbnail} />
            <Switch label="Write metadata JSON" checked={writeInfoJson} onChange={setWriteInfoJson} />
            <Switch label="Write description file" checked={writeDescription} onChange={setWriteDescription} />
            <Switch label="Split chapters into files" checked={splitChapters} onChange={setSplitChapters} />
          </div>

          <TextField
            label="Subtitle Languages"
            value={subtitleLanguages}
            onChange={(e) => {
              setSubtitleLanguages(e.target.value);
            }}
            placeholder="en,ar,all"
            className="font-mono"
            style={{ direction: 'ltr', textAlign: 'left' }}
          />
        </div>

        <div className="space-y-3 border-t border-[var(--border-color)]/50 pt-3">
          <span className="text-xs font-extrabold text-slate-300">Network, Authentication & Recovery</span>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <TextField
              label="Proxy"
              value={mediaProxy}
              onChange={(e) => {
                setMediaProxy(e.target.value);
              }}
              placeholder="http://127.0.0.1:8080"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Cookies From Browser"
              value={cookiesFromBrowser}
              onChange={(e) => {
                setCookiesFromBrowser(e.target.value);
              }}
              placeholder="chrome, edge, firefox"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="User-Agent"
              value={mediaUserAgent}
              onChange={(e) => {
                setMediaUserAgent(e.target.value);
              }}
              placeholder="Mozilla/5.0 ..."
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Referer"
              value={mediaReferer}
              onChange={(e) => {
                setMediaReferer(e.target.value);
              }}
              placeholder="https://example.com/page"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <TextField
              label="Rate Limit (KB/s)"
              type="number"
              value={rateLimitKbs}
              onChange={(e) => {
                setRateLimitKbs(Number(e.target.value));
              }}
            />
            <TextField
              label="Retries"
              type="number"
              value={retries}
              onChange={(e) => {
                setRetries(Number(e.target.value));
              }}
            />
            <TextField
              label="Fragment Retries"
              type="number"
              value={fragmentRetries}
              onChange={(e) => {
                setFragmentRetries(Number(e.target.value));
              }}
            />
            <TextField
              label="Fragments"
              type="number"
              value={concurrentFragments}
              onChange={(e) => {
                setConcurrentFragments(Number(e.target.value));
              }}
            />
            <TextField
              label="Sleep (s)"
              type="number"
              value={sleepIntervalSec}
              onChange={(e) => {
                setSleepIntervalSec(Number(e.target.value));
              }}
            />
            <TextField
              label="Max Sleep (s)"
              type="number"
              value={maxSleepIntervalSec}
              onChange={(e) => {
                setMaxSleepIntervalSec(Number(e.target.value));
              }}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">
                Custom Headers
              </label>
              <textarea
                rows={3}
                value={mediaHeaders}
                onChange={(e) => {
                  setMediaHeaders(e.target.value);
                }}
                placeholder="Header-Name: value"
                className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
                style={{ direction: 'ltr' }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">
                Cookies or Cookies File
              </label>
              <textarea
                rows={3}
                value={mediaCookies}
                onChange={(e) => {
                  setMediaCookies(e.target.value);
                }}
                placeholder="name=value; other=value  or  C:\\path\\cookies.txt"
                className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
                style={{ direction: 'ltr' }}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[var(--text-secondary)] text-[10px] md:text-[11px] font-bold">
              Expert Media Arguments
            </label>
            <textarea
              rows={3}
              value={extraArgs}
              onChange={(e) => {
                setExtraArgs(e.target.value);
              }}
              placeholder="--option value"
              className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus:outline-none focus:border-[var(--accent-primary)]"
              style={{ direction: 'ltr' }}
            />
          </div>
        </div>
      </div>

      {/* Buttons */}
      <div className="flex justify-end gap-2 border-t border-[var(--border-color)] pt-3">
        <DialogButton onClick={closeWithoutKeepingLink} variant="ghost">
          {t('btn_cancel')}
        </DialogButton>
        <DialogButton
          onClick={() => {
            void handleStartDownload();
          }}
          variant="primary"
          className="flex items-center gap-1.5 font-bold bg-red-600 hover:bg-red-700"
        >
          <Download className="w-3.5 h-3.5" />
          {isPlaylistUrl ? 'Download Playlist' : 'Start Download'}
        </DialogButton>
      </div>
    </div>
  );
};
