import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { BridgeState } from '../../core/app-state';
import { Candidate } from '../../contracts/candidate.schema';
import { MAX_HANDOFF_CANDIDATES } from '../../contracts/limits';
import { handoffPolicyDecision } from '../../security/handoff-policy';
import { capabilitiesForCandidate } from '../../contracts/capabilities.schema';
import { useI18n } from '../../i18n/react';
import { X, Download, ChevronUp, List, Table2, Loader2 } from 'lucide-react';
import { messageFromError, runtimeRequest } from '../runtime-request';
import CandidateList from './CandidateList';
import CandidateFilters from './CandidateFilters';
import { QualityTable, StreamQualityItem } from './QualityTable';
import DenseCandidateList from './DenseCandidateList';
import { AnalyzeResultPanel } from './AnalyzeResultPanel';
import { AnalyzeResponse } from '../../contracts/nova.protocol.v4';

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

function isYouTubeCandidate(c: Candidate): boolean {
  const url = c.url ?? '';
  return /youtube\.com\/watch|youtu\.be\/|googlevideo\.com|videoplayback/i.test(url);
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
    const vid = (c.metadata?.videoId as string) || c.url || c.id;
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
  const [analyzeBusy, setAnalyzeBusy] = useState(false);

  /** Start collapsed — only expand on explicit user action. */
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const tone = statusTone(bridge?.status);
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
      const result = await runtimeRequest<{ candidates?: Candidate[] }>({
        type: 'SCAN_PAGE',
        userActivated: true,
      });
      const found = Array.isArray(result?.candidates) ? result.candidates : [];
      setCandidates(found);
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
  async function handleDropdownToggle(): Promise<void> {
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
    if (!bridge?.canSend) {
      setNotice({ kind: 'error', message: 'NOVA desktop is not connected.' });
      return;
    }
    setAnalyzeBusy(true);
    setAnalyzeResult(null);
    try {
      const result = await runtimeRequest<AnalyzeResponse>({
        type: 'ANALYZE_MEDIA',
        url,
        context,
      });
      setAnalyzeResult(result);
      setNotice({ kind: 'success', message: `Found ${result.formats.length} format${result.formats.length !== 1 ? 's' : ''}` });
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    } finally {
      setAnalyzeBusy(false);
    }
  }

  async function analyzeFromDropdown(candidate: Candidate): Promise<void> {
    const url = candidate.finalUrl ?? candidate.url;
    if (!url) return;
    await analyzeUrl(url, {
      pageUrl: candidate.pageUrl,
      referrer: candidate.referrer,
      title: candidate.filename || candidate.metadata?.title as string | undefined,
    });
    setDropdownOpen(false);
  }

  function handleAnalyzeDownload(url: string, filename: string): void {
    setBusy(true);
    void (async () => {
      try {
        await runtimeRequest({ type: 'DOWNLOAD_DIRECT', url, filename });
        setNotice({ kind: 'success', message: t('popup.sentResult', { count: 1 }) });
      } catch (error) {
        setNotice({ kind: 'error', message: messageFromError(error) });
      } finally {
        setBusy(false);
      }
    })();
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
      return <main className="nova-popup-compact nova-popup-compact-empty" />;
    }

    // Videos captured → show download bar + dropdown
    return (
      <div className="nova-popup-compact-wrap" ref={dropdownRef}>
        <main className="nova-popup-compact" data-tone={tone}>
          <div className="nova-compact-bar">
            <button
              type="button"
              className="nova-compact-btn nova-compact-btn-download"
              disabled={busy}
              onClick={() => void handleDropdownToggle()}
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

        {dropdownOpen && (
          <div className="nova-dropdown">
            {notice ? (
              <div className="nova-mini-notice" data-kind={notice.kind}>
                {notice.message}
              </div>
            ) : null}
            <DenseCandidateList
              candidates={videoCandidates}
              bridge={bridge}
              busy={busy}
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
    <main className="nova-popup-mini-mode nova-popup-expanded">
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
              title={viewMode === 'quality' ? 'List' : 'Qualities'}
            >
              {viewMode === 'quality' ? (
                <><List style={{ width: 12, height: 12 }} /> List</>
              ) : (
                <><Table2 style={{ width: 12, height: 12 }} /> Qualities</>
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
                <div className="nova-expanded-other-label">Other Media</div>
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
            <span className="nova-analyze-title">Analysis Result</span>
            <button
              type="button"
              className="nova-mini-btn-text"
              onClick={closeAnalyze}
              title="Close analysis"
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
          <span>Analyzing media formats...</span>
        </div>
      )}

      <footer className="nova-mini-footer">
        <div className="nova-mini-footer-actions">
          <button
            type="button"
            className="nova-mini-btn nova-mini-btn-scan"
            disabled={busy}
            onClick={() => void scan()}
          >
            {busy ? '…' : t('taskActions.scan')}
          </button>
          <button
            type="button"
            className="nova-mini-btn nova-mini-btn-send"
            disabled={busy || !selectedHandoffable}
            onClick={() => void sendSelected()}
          >
            {t('taskActions.sendSelected')}
            {selected.size > 0 ? ` (${selected.size})` : ''}
          </button>
          <button
            type="button"
            className="nova-mini-btn nova-mini-btn-send-all"
            disabled={busy || handoffableCount === 0}
            onClick={() => void sendAll()}
          >
            {t('taskActions.sendAll')}
          </button>
          {bridge?.canSend && videoCandidates.length > 0 && !analyzeResult && (
            <button
              type="button"
              className="nova-mini-btn nova-mini-btn-analyze"
              disabled={busy || analyzeBusy}
              onClick={() => {
                const first = videoCandidates[0];
                if (first) void analyzeUrl(first.finalUrl ?? first.url, {
                  pageUrl: first.pageUrl,
                  referrer: first.referrer,
                  title: first.filename || first.metadata?.title as string | undefined,
                });
              }}
            >
              {analyzeBusy ? '…' : 'Analyze'}
            </button>
          )}
        </div>

        {!bridge?.canSend ? (
          <button
            type="button"
            className="nova-mini-btn nova-mini-btn-connect"
            disabled={busy}
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
