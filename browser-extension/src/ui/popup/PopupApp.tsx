import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { type BridgeState } from '../../core/app-state';
import { type Candidate } from '../../contracts/candidate.schema';
import { MAX_HANDOFF_CANDIDATES } from '../../contracts/limits';
import { handoffPolicyDecision } from '../../security/handoff-policy';
import { capabilitiesForCandidate } from '../../contracts/capabilities.schema';
import { useI18n } from '../../i18n/react';
import { X, Download, ChevronUp, List, Table2, Loader2 } from 'lucide-react';
import { messageFromError, runtimeRequest } from '../runtime-request';
import CandidateList from './CandidateList';
import CandidateFilters from './CandidateFilters';
import { QualityTable, type StreamQualityItem } from './QualityTable';
import DenseCandidateList from './DenseCandidateList';
import { AnalyzeResultPanel } from './AnalyzeResultPanel';
import { type AnalyzeResponse } from '../../contracts/nova.protocol.v4';

type Notice = { kind: 'info' | 'error' | 'success'; message: string };
type CandidateFilter = Candidate['mediaType'] | 'all';
type ViewMode = 'list' | 'quality';

function statusTone(status?: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'connected') return 'success';
  if (
    status === 'reconnecting' ||
    status === 'booting' ||
    status === 'discovering' ||
    status === 'pairing' ||
    status === 'authChecking' ||
    status === 'capabilitySyncing'
  )
    return 'info';
  if (status === 'degraded' || status === 'tokenExpired' || status === 'protocolMismatch') return 'warning';
  return 'danger';
}

function isHandoffable(candidate: Candidate): boolean {
  return handoffPolicyDecision(candidate).allowed;
}

function isSupportedByRuntime(candidate: Candidate, state?: BridgeState): boolean {
  return capabilitiesForCandidate(candidate, state?.capabilities).supported;
}

function unsupportedRuntimeReason(candidate: Candidate, state?: BridgeState): string | undefined {
  const decision = capabilitiesForCandidate(candidate, state?.capabilities);
  if (decision.supported) return undefined;
  return `Desktop runtime capability missing: ${decision.missing ?? 'unknown'}`;
}

function isVideoCand(c: Candidate): boolean {
  return c.mediaType === 'video' || c.mediaType === 'audio';
}

function isYouTubePageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'youtu.be') return /^\/[a-zA-Z0-9_-]{11}(?:\/|$)/.test(parsed.pathname);
    const isYoutubeHost = hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
    if (!isYoutubeHost) return false;
    if (/^\/(?:shorts|live|embed|v)\/[a-zA-Z0-9_-]{11}(?:\/|$)/.test(parsed.pathname)) return true;
    if (parsed.pathname === '/watch') return Boolean(parsed.searchParams.get('v'));
    return parsed.pathname === '/playlist' && Boolean(parsed.searchParams.get('list'));
  } catch {
    return false;
  }
}

function stableYouTubePageUrl(c: Candidate): string | undefined {
  const urls = [c.pageUrl, c.finalUrl, c.url];
  return urls.find((url): url is string => typeof url === 'string' && isYouTubePageUrl(url));
}

function isYouTubeCandidate(c: Candidate): boolean {
  const url = c.finalUrl ?? c.url ?? '';
  return Boolean(stableYouTubePageUrl(c)) || /googlevideo\.com|videoplayback/i.test(url);
}

function hasVideoQualities(candidate: Candidate): boolean {
  return (candidate.mediaType === 'video' || candidate.mediaType === 'audio') && !!candidate.url;
}

function qualifyForQualityView(candidates: Candidate[]): boolean {
  const videoCands = candidates.filter(hasVideoQualities);
  if (videoCands.length < 2) return false;
  if (videoCands.some(isYouTubeCandidate)) return true;
  const withDimensions = videoCands.filter((c) => c.width && c.height);
  if (withDimensions.length >= 3) {
    const heights = new Set(withDimensions.map((c) => c.height));
    return heights.size >= 2;
  }
  return false;
}

function parseYouTubeDuration(sec?: number): number | undefined {
  return sec && Number.isFinite(sec) && sec > 0 ? sec : undefined;
}

function candidateToQualityItem(c: Candidate, videoTitle?: string): StreamQualityItem | null {
  if (!c.url) return null;
  const isAudio = c.mediaType === 'audio' || (c.mimeType?.startsWith('audio/') ?? false);
  return {
    id: c.id,
    url: c.url,
    quality: c.width && c.height ? (c.height >= 2160 ? '4K' : `${c.height}p`) : undefined,
    label: (c.metadata?.qualityLabel as string) || undefined,
    width: c.width,
    height: c.height,
    bandwidth: c.bitrate,
    codecs: c.codecs?.[0],
    container: c.extension,
    fps: c.metadata?.fps ? parseInt(String(c.metadata.fps), 10) || undefined : undefined,
    hdr: c.metadata?.hdr === 'true' || c.metadata?.hdr === '1',
    sizeBytes: c.sizeBytes,
    type: isAudio ? 'audio' : 'video',
    formatId: c.metadata?.itag as string | undefined,
    videoTitle,
  };
}

function variantsToQualityItems(c: Candidate, videoTitle?: string): StreamQualityItem[] {
  if (!c.variants || c.variants.length === 0) return [];
  return c.variants.map((v, i) => ({
    id: `${c.id}-v${i}`,
    url: v.url,
    quality: v.height ? `${v.height}p` : v.label || v.mimeType?.split('/')[1],
    label: v.label,
    width: v.width,
    height: v.height,
    bandwidth: v.bandwidth,
    codecs: v.codecs,
    container: c.extension,
    type: c.mediaType === 'audio' ? 'audio' : 'video',
    formatId: `${i}`,
    videoTitle,
  }));
}

function groupYouTubeCandidates(candidates: Candidate[]): Map<string, Candidate[]> {
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!isYouTubeCandidate(c)) continue;
    const vid = (c.metadata?.videoId as string) || stableYouTubePageUrl(c) || c.url || c.id;
    const existing = groups.get(vid);
    if (existing) {
      existing.push(c);
    } else {
      groups.set(vid, [c]);
    }
  }
  return groups;
}

function getQualityTitle(candidates: Candidate[]): string {
  const title = candidates.find((c) => c.metadata?.title)?.metadata?.title as string | undefined;
  return title || '';
}

function getThumbnailUrl(candidates: Candidate[]): string | undefined {
  const vid = candidates.find((c) => c.metadata?.videoId)?.metadata?.videoId as string | undefined;
  if (vid) return `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
  return undefined;
}

export function PopupApp() {
  const { t } = useI18n();
  const [bridge, setBridge] = useState<BridgeState>();
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState<CandidateFilter>('all');
  const [autoScanned, setAutoScanned] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [sentQualityIds, setSentQualityIds] = useState<Set<string>>(() => new Set());
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResponse | null>(null);
  const [scannedPageUrl, setScannedPageUrl] = useState<string>();
  const [analyzeBusy, setAnalyzeBusy] = useState(false);
  // State updates are asynchronous, so a ref closes the small window in
  // which two rapid clicks could otherwise start concurrent yt-dlp probes.
  const analyzeFlightRef = useRef(false);

  /** Start collapsed — only expand on explicit user action. */
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const tone = statusTone(bridge?.status);
  const actionBusy = busy || analyzeBusy;
  const videoCandidates = candidates.filter(isVideoCand);

  const youtubeGroups = useMemo(() => groupYouTubeCandidates(videoCandidates), [videoCandidates]);
  const showQualityToggle = qualifyForQualityView(videoCandidates);
  const nonYouTubeCandidates = useMemo(
    () => videoCandidates.filter((c) => !isYouTubeCandidate(c)),
    [videoCandidates],
  );

  const refresh = useCallback(async (showErrors = true): Promise<void> => {
    try {
      const state = await runtimeRequest<BridgeState>({ type: 'GET_BRIDGE_STATE' });
      setBridge(state);
    } catch (error) {
      if (showErrors) setNotice({ kind: 'error', message: messageFromError(error) });
    }
  }, []);

  const loadCandidates = useCallback(async (): Promise<void> => {
    try {
      const list = await runtimeRequest<Candidate[]>({ type: 'GET_CANDIDATES' });
      setCandidates(Array.isArray(list) ? list : []);
    } catch {
      /* cache may be empty */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadCandidates();
    let interval: number | undefined;

    function startPolling() {
      window.clearInterval(interval);
      interval = window.setInterval(() => {
        void refresh(false);
        void loadCandidates();
      }, 3000);
    }
    function stopPolling() {
      window.clearInterval(interval);
    }
    function onVisibilityChange() {
      if (document.hidden) stopPolling();
      else startPolling();
    }

    startPolling();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh, loadCandidates]);

  // On open: load cache then quietly rescan the active tab for video streams.
  useEffect(() => {
    if (autoScanned || busy) return;
    void (async () => {
      await loadCandidates();
      await scan({ quiet: true });
      setAutoScanned(true);
    })();
  }, [autoScanned, busy]);

  useEffect(() => {
    if (showQualityToggle && viewMode === 'list') {
      setViewMode('quality');
    }
  }, [showQualityToggle, viewMode]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  function toggleSelected(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function scan(options: { quiet?: boolean } = {}): Promise<Candidate[]> {
    setBusy(true);
    try {
      const result = await runtimeRequest<{ candidates?: Candidate[]; pageUrl?: string }>({
        type: 'SCAN_PAGE',
        userActivated: true,
      });
      const found = Array.isArray(result?.candidates) ? result.candidates : [];
      setCandidates(found);
      setScannedPageUrl(typeof result?.pageUrl === 'string' ? result.pageUrl : undefined);
      setSelected(new Set());
      setSentQualityIds(new Set());
      if (!options.quiet) {
        const videoFound = found.filter(isVideoCand);
        if (videoFound.length > 0) {
          setNotice({ kind: 'success', message: t('popup.scanFound', { count: videoFound.length }) });
        } else {
          setNotice({ kind: 'info', message: t('popup.scanNone') });
        }
      }
      return found;
    } catch (error) {
      if (!options.quiet) setNotice({ kind: 'error', message: messageFromError(error) });
      return [];
    } finally {
      setBusy(false);
      void refresh(false);
    }
  }

  /** Toggle dense dropdown under compact bar. */
  async function handlePrimaryDownload(): Promise<void> {
    if (actionBusy) return;
    const youtubeCandidate = videoCandidates.find(isYouTubeCandidate);
    if (youtubeCandidate) {
      await analyzeFromDropdown(youtubeCandidate);
      return;
    }
    if (scannedPageUrl && isYouTubePageUrl(scannedPageUrl)) {
      setExpanded(true);
      setDropdownOpen(false);
      await analyzeUrl(scannedPageUrl, { pageUrl: scannedPageUrl });
      return;
    }
    await handleDropdownToggle();
  }

  async function handleDropdownToggle(): Promise<void> {
    if (actionBusy) return;
    if (dropdownOpen) {
      setDropdownOpen(false);
      return;
    }
    if (videoCandidates.length === 0) {
      setBusy(true);
      await scan({ quiet: true });
      setBusy(false);
    }
    setDropdownOpen(true);
  }

  /** Send a single candidate from the dense dropdown. */
  async function sendFromDropdown(candidate: Candidate): Promise<void> {
    setBusy(true);
    try {
      if (isYouTubeCandidate(candidate)) {
        await analyzeFromDropdown(candidate);
        return;
      }
      const isManifest = /\.(m3u8|mpd)$/i.test(candidate.url);
      if (isManifest) {
        await runtimeRequest({ type: 'SEND_CANDIDATE', candidate });
      } else {
        const title = (candidate.metadata?.title as string | undefined)
          ?.replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 100) || 'video';
        const quality = candidate.height
          ? `${candidate.height}p`
          : candidate.bitrate
            ? `${Math.round(candidate.bitrate / 1000)}kbps`
            : 'video';
        const ext = candidate.extension || 'mp4';
        await runtimeRequest({
          type: 'DOWNLOAD_DIRECT',
          url: candidate.url,
          filename: `${title} [${quality}].${ext}`,
        });
      }
      setNotice({ kind: 'success', message: t('popup.sentResult', { count: 1 }) });
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    } finally {
      setBusy(false);
      void refresh(false);
    }
  }

  /** Send all handoffable candidates from the dense dropdown. */
  async function sendAllFromDropdown(source: Candidate[]): Promise<void> {
    setBusy(true);
    try {
      const youtubeCandidate = source.find(isYouTubeCandidate);
      if (youtubeCandidate) {
        await analyzeFromDropdown(youtubeCandidate);
        return;
      }
      const manifestCandidates = source.filter((c) => /\.(m3u8|mpd)$/i.test(c.url));
      const directCandidates = source.filter((c) => !/\.(m3u8|mpd)$/i.test(c.url));
      if (manifestCandidates.length > 0) {
        await runtimeRequest({ type: 'SEND_BATCH', candidates: manifestCandidates });
      }
      for (const c of directCandidates) {
        const title = (c.metadata?.title as string | undefined)
          ?.replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 100) || 'video';
        const quality = c.height
          ? `${c.height}p`
          : c.bitrate
            ? `${Math.round(c.bitrate / 1000)}kbps`
            : 'video';
        const ext = c.extension || 'mp4';
        await runtimeRequest({
          type: 'DOWNLOAD_DIRECT',
          url: c.url,
          filename: `${title} [${quality}].${ext}`,
        });
      }
      setNotice({ kind: 'success', message: t('popup.sentResult', { count: source.length }) });
      setDropdownOpen(false);
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    } finally {
      setBusy(false);
      void refresh(false);
    }
  }

  async function sendSelected(): Promise<void> {
    const chosen = videoCandidates
      .filter((c) => selected.has(c.id) && isHandoffable(c) && isSupportedByRuntime(c, bridge))
      .slice(0, MAX_HANDOFF_CANDIDATES);
    if (chosen.length === 0) {
      setNotice({ kind: 'error', message: t('popup.noSelected') });
      return;
    }
    setBusy(true);
    setNotice({ kind: 'info', message: t('popup.sending', { count: chosen.length }) });
    try {
      await runtimeRequest({ type: 'SEND_BATCH', candidates: chosen });
      setSelected(new Set());
      setNotice({ kind: 'success', message: t('popup.sentResult', { count: chosen.length }) });
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    } finally {
      setBusy(false);
      void refresh(false);
    }
  }

  async function sendAll(source: Candidate[] = videoCandidates): Promise<void> {
    const youtubeCandidate = source.find(isYouTubeCandidate);
    if (youtubeCandidate) {
      await analyzeFromDropdown(youtubeCandidate);
      return;
    }
    const handoffable = source
      .filter((c) => isHandoffable(c) && isSupportedByRuntime(c, bridge))
      .slice(0, MAX_HANDOFF_CANDIDATES);
    if (handoffable.length === 0) {
      // Still allow direct browser downloads when the desktop bridge is offline.
      const directOnly = source
        .filter((c) => isHandoffable(c) && !/\.(m3u8|mpd)$/i.test(c.url))
        .slice(0, MAX_HANDOFF_CANDIDATES);
      if (directOnly.length === 0) {
        setNotice({ kind: 'error', message: t('popup.noCandidates') });
        return;
      }
      setBusy(true);
      try {
        for (const c of directOnly) {
          const title =
            (c.metadata?.title as string | undefined)?.replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 100) ||
            'video';
          const quality = c.height
            ? `${c.height}p`
            : c.bitrate
              ? `${Math.round(c.bitrate / 1000)}kbps`
              : 'video';
          const ext = c.extension || 'mp4';
          await runtimeRequest({
            type: 'DOWNLOAD_DIRECT',
            url: c.url,
            filename: `${title} [${quality}].${ext}`,
          });
        }
        setNotice({ kind: 'success', message: t('popup.sentResult', { count: directOnly.length }) });
      } catch (error) {
        setNotice({ kind: 'error', message: messageFromError(error) });
      } finally {
        setBusy(false);
        void refresh(false);
      }
      return;
    }
    setBusy(true);
    setNotice({ kind: 'info', message: t('popup.sending', { count: handoffable.length }) });
    try {
      const manifestCandidates = handoffable.filter((c) => /\.(m3u8|mpd)$/i.test(c.url));
      const directCandidates = handoffable.filter((c) => !/\.(m3u8|mpd)$/i.test(c.url));
      if (manifestCandidates.length > 0) {
        await runtimeRequest({ type: 'SEND_BATCH', candidates: manifestCandidates });
      }
      for (const c of directCandidates) {
        const title =
          (c.metadata?.title as string | undefined)?.replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 100) ||
          'video';
        const quality = c.height
          ? `${c.height}p`
          : c.bitrate
            ? `${Math.round(c.bitrate / 1000)}kbps`
            : 'video';
        const ext = c.extension || 'mp4';
        await runtimeRequest({
          type: 'DOWNLOAD_DIRECT',
          url: c.url,
          filename: `${title} [${quality}].${ext}`,
        });
      }
      setSelected(new Set());
      setNotice({ kind: 'success', message: t('popup.sentResult', { count: handoffable.length }) });
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    } finally {
      setBusy(false);
      void refresh(false);
    }
  }

  async function handleSendQuality(qualityItem: StreamQualityItem): Promise<void> {
    const candidateId = qualityItem.id.replace(/-v\d+$/, '');
    const sourceCandidate = videoCandidates.find(
      (candidate) =>
        candidate.id === candidateId ||
        candidate.url === qualityItem.url ||
        candidate.finalUrl === qualityItem.url,
    );
    if (sourceCandidate && isYouTubeCandidate(sourceCandidate)) {
      await analyzeFromDropdown(sourceCandidate);
      return;
    }

    const isManifest = qualityItem.url.endsWith('.m3u8') || qualityItem.url.endsWith('.mpd');

    if (isManifest) {
      let found: Candidate | undefined = videoCandidates.find((c) => c.id === qualityItem.id);
      if (!found) {
        const variantMatch = qualityItem.id.match(/^(.+)-v(\d+)$/);
        if (variantMatch) found = videoCandidates.find((c) => c.id === variantMatch[1]);
      }
      if (!found) {
        found = videoCandidates.find((c) => c.url === qualityItem.url || c.finalUrl === qualityItem.url);
      }
      const pageUrl = found?.pageUrl;
      const sendCandidate: Candidate = found || {
        id: qualityItem.id,
        url: qualityItem.url,
        pageUrl,
        source: 'platform' as const,
        mediaType: qualityItem.type,
        mimeType: qualityItem.type === 'video' ? 'video/mp4' : 'audio/mp4',
        width: qualityItem.width,
        height: qualityItem.height,
        bitrate: qualityItem.bandwidth,
        extension: qualityItem.container,
        codecs: qualityItem.codecs ? [qualityItem.codecs] : undefined,
        sizeBytes: qualityItem.sizeBytes,
        confidence: 70,
        createdAt: new Date().toISOString(),
      };
      if (!isHandoffable(sendCandidate) || !isSupportedByRuntime(sendCandidate, bridge)) {
        setNotice({ kind: 'error', message: t('popup.noCandidates') });
        return;
      }
      setBusy(true);
      try {
        await runtimeRequest({ type: 'SEND_CANDIDATE', candidate: sendCandidate });
        setSentQualityIds((prev) => new Set(prev).add(qualityItem.id));
        setNotice({
          kind: 'success',
          message: t('popup.sentResult', { count: 1 }),
        });
      } catch (error) {
        setNotice({ kind: 'error', message: messageFromError(error) });
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const qualityLabel =
        qualityItem.label || qualityItem.quality || (qualityItem.height ? `${qualityItem.height}p` : 'video');
      const ext = qualityItem.container || 'mp4';
      const title = qualityItem.videoTitle?.replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 100) || 'video';
      const filename = qualityItem.videoTitle
        ? `${title} [${qualityLabel}].${ext}`
        : `${qualityLabel}.${ext}`;
      await runtimeRequest({ type: 'DOWNLOAD_DIRECT', url: qualityItem.url, filename });
      setSentQualityIds((prev) => new Set(prev).add(qualityItem.id));
      setNotice({ kind: 'success', message: t('popup.sentResult', { count: 1 }) });
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleSendBestQuality(): Promise<void> {
    const allItems: StreamQualityItem[] = [];
    for (const [, group] of youtubeGroups) {
      const title = getQualityTitle(group);
      const directItems = group
        .map((c) => candidateToQualityItem(c, title))
        .filter((q): q is StreamQualityItem => q !== null);
      const varItems = group.flatMap((c) => variantsToQualityItems(c, title));
      allItems.push(...(varItems.length > 0 ? varItems : directItems));
    }
    if (allItems.length === 0) {
      const pageTitle = videoCandidates[0]?.metadata?.title as string | undefined;
      const directItems = videoCandidates
        .map((c) => candidateToQualityItem(c, pageTitle))
        .filter((q): q is StreamQualityItem => q !== null);
      const varItems = videoCandidates.flatMap((c) => variantsToQualityItems(c, pageTitle));
      allItems.push(...(varItems.length > 0 ? varItems : directItems));
    }
    const videoItems = allItems.filter((q) => q.type === 'video' && q.height);
    const sorted = [...videoItems].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    if (sorted.length > 0) {
      await handleSendQuality(sorted[0]!);
    } else if (allItems.length > 0) {
      await handleSendQuality(allItems[0]!);
    }
  }

  async function analyzeUrl(url: string, context?: { pageUrl?: string; referrer?: string; title?: string }): Promise<void> {
    if (analyzeFlightRef.current) return;
    if (!bridge?.canSend) {
      setNotice({ kind: 'error', message: t('popup.message.cannotSend') });
      return;
    }
    analyzeFlightRef.current = true;
    setAnalyzeBusy(true);
    setAnalyzeResult(null);
    try {
      const result = await runtimeRequest<AnalyzeResponse>({
        type: 'ANALYZE_MEDIA',
        url,
        context,
      });
      if (!result.ok || result.drmProtected || result.formats.length === 0) {
        // Keep user-facing text localized; analysisCode is intentionally only a
        // bounded diagnostic category, never a raw extractor error string.
        throw new Error(t('quality.noneFromNOVA'));
      }
      setAnalyzeResult(result);
      setNotice({ kind: 'success', message: t('quality.header', { n: result.formats.length }) });
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    } finally {
      analyzeFlightRef.current = false;
      setAnalyzeBusy(false);
    }
  }

  async function analyzeFromDropdown(candidate: Candidate): Promise<void> {
    const stablePageUrl = stableYouTubePageUrl(candidate);
    if (isYouTubeCandidate(candidate) && !stablePageUrl) {
      setNotice({ kind: 'error', message: t('quality.noneFromNOVA') });
      return;
    }
    const url = stablePageUrl ?? candidate.finalUrl ?? candidate.url;
    if (!url) return;
    setExpanded(true);
    setDropdownOpen(false);
    await analyzeUrl(url, {
      pageUrl: candidate.pageUrl ?? url,
      referrer: candidate.referrer,
      title: candidate.filename || candidate.metadata?.title as string | undefined,
    });
  }

  async function handleAnalyzeDownload(format: AnalyzeResponse['formats'][number]): Promise<boolean> {
    const sourceUrl = analyzeResult?.url;
    if (actionBusy) return false;
    if (analyzeResult?.drmProtected) {
      setNotice({ kind: 'error', message: t('popup.noCandidates') });
      return false;
    }
    if (!sourceUrl || !format.formatId) {
      setNotice({ kind: 'error', message: t('quality.noneFromNOVA') });
      return false;
    }
    setBusy(true);
    try {
      const result = await runtimeRequest<{ accepted?: boolean; message?: string }>({
        type: 'ADD_YTDLP_MEDIA',
        url: sourceUrl,
        title: analyzeResult?.title,
        pageUrl: sourceUrl,
        selectedFormat: {
          ...format,
          // The desktop deliberately receives the stable page URL and a format
          // identifier. A CDN delivery URL can expire and is never used as the
          // managed-media task URL.
          url: format.url || sourceUrl,
        },
        drmProtected: Boolean(analyzeResult?.drmProtected),
      });
      if (!result?.accepted) {
        throw new Error(result?.message || t('quality.novaNotAccepted'));
      }
      setNotice({ kind: 'success', message: t('popup.sentResult', { count: 1 }) });
      return true;
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function closeAnalyze(): void {
    setAnalyzeResult(null);
  }

  if (dismissed) {
    return null;
  }

  const visibleCandidates =
    filter === 'all' ? videoCandidates : videoCandidates.filter((c) => c.mediaType === filter);
  const handoffableCount = videoCandidates.filter(
    (c) => isHandoffable(c) && (isSupportedByRuntime(c, bridge) || !/\.(m3u8|mpd)$/i.test(c.url)),
  ).length;
  const selectedHandoffable = videoCandidates.some(
    (c) => selected.has(c.id) && isHandoffable(c) && isSupportedByRuntime(c, bridge),
  );

  // ── Compact bar: only visible when videos captured ─────────────────────
  if (!expanded) {
    // No videos → render nothing
    if (videoCandidates.length === 0 && !busy) {
      if (scannedPageUrl && isYouTubePageUrl(scannedPageUrl)) {
        return (
          <main className="nova-popup-compact nova-popup-compact-youtube" data-tone={tone} aria-busy={actionBusy}>
            <button
              type="button"
              className="nova-compact-btn nova-compact-btn-download"
              disabled={actionBusy}
              onClick={() => void handlePrimaryDownload()}
              title={t('quality.resolveViaNOVA')}
            >
              <Download style={{ width: 14, height: 14 }} aria-hidden />
              <span>{t('quality.resolveViaNOVA')}</span>
            </button>
          </main>
        );
      }
      return <main className="nova-popup-compact nova-popup-compact-empty" aria-hidden="true" />;
    }

    // Videos captured → show download bar + dropdown
    return (
      <div className="nova-popup-compact-wrap" ref={dropdownRef}>
        <main className="nova-popup-compact" data-tone={tone} aria-busy={actionBusy}>
          <div className="nova-compact-bar">
            <button
              type="button"
              className="nova-compact-btn nova-compact-btn-download"
              disabled={actionBusy}
              onClick={() => void handlePrimaryDownload()}
              title={t('popup.action.download')}
            >
              <Download style={{ width: 14, height: 14 }} aria-hidden />
              <span>{busy ? '…' : t('popup.action.download')}</span>
            </button>

            <button
              type="button"
              className="nova-compact-btn-close"
              aria-label={t('popup.action.close')}
              title={t('popup.action.close')}
              onClick={() => setDismissed(true)}
            >
              <X style={{ width: 14, height: 14 }} />
            </button>
          </div>
        </main>

        {/* A compact YouTube action can fail before a dropdown is opened.
            Keep that localized status visible instead of silently retaining it
            in state behind an unopened panel. */}
        {notice && !dropdownOpen ? (
          <div className="nova-mini-notice nova-compact-notice" data-kind={notice.kind} role="status" aria-live="polite">
            {notice.message}
          </div>
        ) : null}

        {dropdownOpen && (
          <div className="nova-dropdown">
            {notice ? (
              <div className="nova-mini-notice" data-kind={notice.kind} role="status" aria-live="polite">
                {notice.message}
              </div>
            ) : null}
            <DenseCandidateList
              candidates={videoCandidates}
              bridge={bridge}
              busy={actionBusy}
              onSend={(c) => void sendFromDropdown(c)}
              onSendAll={(cs) => void sendAllFromDropdown(cs)}
              onAnalyze={(c) => void analyzeFromDropdown(c)}
            />
          </div>
        )}
      </div>
    );
  }

  // ── Expanded: captured videos list ─────────────────────────────────────
  return (
    <main className="nova-popup-mini-mode nova-popup-expanded" aria-busy={actionBusy}>
      <header className="nova-mini-header">
        <div className="nova-mini-brand">
          <span className="nova-mini-status" data-tone={tone}>
            <span className="nova-mini-dot" />
            {busy
              ? t('popup.scanning')
              : videoCandidates.length > 0
                ? `${videoCandidates.length} ${t('popup.handoffable')}`
                : bridge?.canSend
                  ? t('popup.ready')
                  : t('popup.needsCheck')}
          </span>
        </div>

        <div className="nova-mini-header-actions">
          {showQualityToggle && (
            <button
              type="button"
              className="nova-mini-btn-text"
              onClick={() => setViewMode(viewMode === 'quality' ? 'list' : 'quality')}
              title={viewMode === 'quality' ? t('popup.tab.candidates') : t('quality.header', { n: videoCandidates.length })}
            >
              {viewMode === 'quality' ? (
                <><List style={{ width: 12, height: 12 }} /> {t('popup.tab.candidates')}</>
              ) : (
                <><Table2 style={{ width: 12, height: 12 }} /> {t('quality.header', { n: videoCandidates.length })}</>
              )}
            </button>
          )}
          {videoCandidates.length > 0 && (
            <span className="nova-mini-count-badge">{videoCandidates.length}</span>
          )}
          <button
            type="button"
            className="nova-mini-btn-text"
            onClick={() => setExpanded(false)}
            title={t('popup.action.collapse')}
            aria-label={t('popup.action.collapse')}
          >
            <ChevronUp style={{ width: 14, height: 14 }} />
          </button>
          <button
            type="button"
            className="nova-mini-btn-close"
            aria-label={t('popup.action.close')}
            title={t('popup.action.close')}
            onClick={() => setDismissed(true)}
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>
      </header>

      {notice ? (
        <div className="nova-mini-notice" data-kind={notice.kind}>
          {notice.message}
        </div>
      ) : null}

      {bridge?.lastError ? (
        <div className="nova-mini-notice" data-kind="error">
          <strong>{bridge.lastError.code}</strong>: {bridge.lastError.message}
        </div>
      ) : null}

      {videoCandidates.length === 0 && !busy ? (
        <div className="nova-mini-empty">
          <p>{t('candidate.empty.title')}</p>
          <p className="nova-mini-empty-hint">{t('candidate.empty.help')}</p>
        </div>
      ) : busy && videoCandidates.length === 0 ? (
        <div className="nova-mini-empty">
          <p>{t('popup.scanning')}</p>
          <p className="nova-mini-empty-hint">{t('candidate.empty.help')}</p>
        </div>
      ) : (
        <>
          {viewMode === 'quality' && (
            <div className="nova-expanded-scroll">
              {Array.from(youtubeGroups.entries()).map(([, group]) => {
                const title = getQualityTitle(group);
                const directItems = group
                  .map((c) => candidateToQualityItem(c, title))
                  .filter((q): q is StreamQualityItem => q !== null);
                const variantItems = group.flatMap((c) => variantsToQualityItems(c, title));
                const qualityItems = variantItems.length > 0 ? variantItems : directItems;
                if (qualityItems.length === 0) return null;
                const thumbnail = getThumbnailUrl(group);
                const duration = parseYouTubeDuration(group.find((c) => c.durationSec)?.durationSec);

                return (
                  <QualityTable
                    key={group[0]?.id || 'yt-group'}
                    qualities={qualityItems}
                    videoTitle={title}
                    thumbnailUrl={thumbnail}
                    durationSec={duration}
                    onSendQuality={handleSendQuality}
                    onSendBest={handleSendBestQuality}
                    busy={busy}
                    sentIds={sentQualityIds}
                  />
                );
              })}

              {youtubeGroups.size === 0 &&
                (() => {
                  const pageTitle = videoCandidates[0]?.metadata?.title as string | undefined;
                  const directItems = videoCandidates
                    .map((c) => candidateToQualityItem(c, pageTitle))
                    .filter((q): q is StreamQualityItem => q !== null);
                  const variantItems = videoCandidates.flatMap((c) => variantsToQualityItems(c, pageTitle));
                  const qualityItems = variantItems.length > 0 ? variantItems : directItems;
                  if (qualityItems.length < 2) return null;
                  const duration = parseYouTubeDuration(
                    videoCandidates.find((c) => c.durationSec)?.durationSec,
                  );
                  return (
                    <QualityTable
                      key="page-qualities"
                      qualities={qualityItems}
                      videoTitle={pageTitle}
                      durationSec={duration}
                      onSendQuality={handleSendQuality}
                      onSendBest={handleSendBestQuality}
                      busy={busy}
                      sentIds={sentQualityIds}
                    />
                  );
                })()}
            </div>
          )}

          {(viewMode === 'list' || nonYouTubeCandidates.length > 0) && (
            <div
              className={
                viewMode === 'quality' && nonYouTubeCandidates.length > 0
                  ? 'nova-expanded-other'
                  : undefined
              }
            >
              {viewMode === 'quality' && nonYouTubeCandidates.length > 0 && (
                <div className="nova-expanded-other-label">{t('candidate.filter.other')}</div>
              )}
              {videoCandidates.length > 0 && viewMode === 'list' && (
                <CandidateFilters value={filter} onChange={setFilter} />
              )}
              <CandidateList
                candidates={viewMode === 'list' ? visibleCandidates : nonYouTubeCandidates}
                selected={selected}
                isCandidateSupported={(c) => isSupportedByRuntime(c, bridge)}
                unsupportedReason={(c) => unsupportedRuntimeReason(c, bridge)}
                onToggle={toggleSelected}
              />
            </div>
          )}
        </>
      )}

      {/* Analyze result panel */}
      {analyzeResult && (
        <div className="nova-analyze-wrap">
          <div className="nova-analyze-bar">
            <span className="nova-analyze-title">{t('quality.resolveViaNOVA')}</span>
            <button
              type="button"
              className="nova-mini-btn-text"
              onClick={closeAnalyze}
              title={t('popup.action.close')}
              aria-label={t('popup.action.close')}
            >
              <X style={{ width: 12, height: 12 }} />
            </button>
          </div>
          <AnalyzeResultPanel
            result={analyzeResult}
            onDownload={handleAnalyzeDownload}
            busy={busy || analyzeBusy}
          />
        </div>
      )}

      {/* Analyze loading indicator */}
      {analyzeBusy && !analyzeResult && (
        <div className="nova-analyze-loading">
          <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} />
          <span>{t('quality.resolving')}</span>
        </div>
      )}

      <footer className="nova-mini-footer">
        <div className="nova-mini-footer-actions">
          <button
            type="button"
            className="nova-mini-btn nova-mini-btn-scan"
            disabled={actionBusy}
            onClick={() => void scan()}
          >
            {busy ? '…' : t('taskActions.scan')}
          </button>
          <button
            type="button"
            className="nova-mini-btn nova-mini-btn-send"
            disabled={actionBusy || !selectedHandoffable}
            onClick={() => void sendSelected()}
          >
            {t('taskActions.sendSelected')}
            {selected.size > 0 ? ` (${selected.size})` : ''}
          </button>
          <button
            type="button"
            className="nova-mini-btn nova-mini-btn-send-all"
            disabled={actionBusy || handoffableCount === 0}
            onClick={() => void sendAll()}
          >
            {t('taskActions.sendAll')}
          </button>
          {bridge?.canSend && videoCandidates.length > 0 && !analyzeResult && (
            <button
              type="button"
              className="nova-mini-btn nova-mini-btn-analyze"
              disabled={actionBusy}
              onClick={() => {
                const first = videoCandidates[0];
                if (first) void analyzeUrl(first.finalUrl ?? first.url, {
                  pageUrl: first.pageUrl,
                  referrer: first.referrer,
                  title: first.filename || first.metadata?.title as string | undefined,
                });
              }}
            >
              {analyzeBusy ? '…' : t('quality.resolveViaNOVA')}
            </button>
          )}
        </div>

        {!bridge?.canSend ? (
          <button
            type="button"
            className="nova-mini-btn nova-mini-btn-connect"
            disabled={actionBusy}
            onClick={() => void runtimeRequest({ type: 'OPEN_NOVA' })}
          >
            {t('popup.action.linkNova')}
          </button>
        ) : null}
      </footer>
    </main>
  );
}

export default PopupApp;
