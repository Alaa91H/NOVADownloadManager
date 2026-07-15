import React, { useCallback, useEffect, useState, useMemo } from 'react';
import { BridgeState } from '../../core/app-state';
import { Candidate } from '../../contracts/candidate.schema';
import { MAX_HANDOFF_CANDIDATES } from '../../contracts/limits';
import { handoffPolicyDecision } from '../../security/handoff-policy';
import { capabilitiesForCandidate } from '../../contracts/capabilities.schema';
import { useI18n } from '../../i18n/react';
import AppLogo from '../components/AppLogo';
import { X, Download, ChevronDown, List, Table2 } from 'lucide-react';
import { messageFromError, runtimeRequest } from '../runtime-request';
import CandidateList from './CandidateList';
import CandidateFilters from './CandidateFilters';
import { QualityTable, StreamQualityItem } from './QualityTable';

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
  // YouTube candidates always qualify
  if (videoCands.some(isYouTubeCandidate)) return true;
  // Non-YouTube: qualify if there are 3+ candidates with different heights or bitrates
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

/** Generate quality items from a candidate's HLS/DASH variants */
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

/** Group YouTube candidates by video ID */
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

  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const tone = statusTone(bridge?.status);
  const videoCandidates = candidates.filter(isVideoCand);
  const hasVideo = videoCandidates.length > 0;

  // YouTube-specific groupings
  const youtubeGroups = useMemo(() => {
    return groupYouTubeCandidates(videoCandidates);
  }, [videoCandidates]);
  const showQualityToggle = qualifyForQualityView(videoCandidates);

  const nonYouTubeCandidates = useMemo(() => {
    return videoCandidates.filter((c) => !isYouTubeCandidate(c));
  }, [videoCandidates]);

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
      const found = Array.isArray(list) ? list : [];
      setCandidates(found);
    } catch { /* silently fail - candidates may not be available */ }
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

  useEffect(() => {
    if (autoScanned || busy) return;
    if (!bridge?.canSend) return;
    void scan();
    setAutoScanned(true);
  }, [bridge?.canSend, autoScanned, busy]);

  // Auto-switch to quality view when YouTube qualities detected
  useEffect(() => {
    if (showQualityToggle && viewMode === 'list') {
      setViewMode('quality');
    }
  }, [showQualityToggle]);

  function toggleSelected(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function scan(): Promise<void> {
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
      const videoFound = found.filter(isVideoCand);
      if (videoFound.length > 0) {
        setNotice({
          kind: 'success',
          message: t('popup.scanFound', { count: videoFound.length }),
        });
      } else {
        setNotice({ kind: 'info', message: t('popup.scanNone') });
      }
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    } finally {
      setBusy(false);
      void refresh(false);
    }
  }

  async function sendSelected(): Promise<void> {
    const chosen = videoCandidates
      .filter(
        (c) =>
          selected.has(c.id) && isHandoffable(c) && isSupportedByRuntime(c, bridge),
      )
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

  async function sendAll(): Promise<void> {
    const handoffable = videoCandidates
      .filter((c) => isHandoffable(c) && isSupportedByRuntime(c, bridge))
      .slice(0, MAX_HANDOFF_CANDIDATES);
    if (handoffable.length === 0) {
      setNotice({ kind: 'error', message: t('popup.noCandidates') });
      return;
    }
    setBusy(true);
    setNotice({ kind: 'info', message: `Downloading ${handoffable.length} file(s)...` });
    try {
      const manifestCandidates = handoffable.filter((c) => /\.(m3u8|mpd)$/i.test(c.url));
      const directCandidates = handoffable.filter((c) => !/\.(m3u8|mpd)$/i.test(c.url));
      if (manifestCandidates.length > 0) {
        await runtimeRequest({ type: 'SEND_BATCH', candidates: manifestCandidates });
      }
      for (const c of directCandidates) {
        const title = (c.metadata?.title as string | undefined)?.replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 100) || 'video';
        const quality = c.height ? `${c.height}p` : c.bitrate ? `${Math.round(c.bitrate / 1000)}kbps` : 'video';
        const ext = c.extension || 'mp4';
        const filename = `${title} [${quality}].${ext}`;
        await runtimeRequest({ type: 'DOWNLOAD_DIRECT', url: c.url, filename });
      }
      setSelected(new Set());
      setNotice({ kind: 'success', message: `Download started for ${handoffable.length} file(s)` });
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
      // Manifest streams need the daemon
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
        setNotice({ kind: 'error', message: 'This stream cannot be sent to NOVA.' });
        return;
      }
      setBusy(true);
      try {
        await runtimeRequest({ type: 'SEND_CANDIDATE', candidate: sendCandidate });
        setSentQualityIds((prev) => new Set(prev).add(qualityItem.id));
        setNotice({ kind: 'success', message: `Sent to NOVA: ${qualityItem.label || qualityItem.quality || 'selected quality'}` });
      } catch (error) {
        setNotice({ kind: 'error', message: messageFromError(error) });
      } finally {
        setBusy(false);
      }
      return;
    }

    // Direct browser download for direct URLs
    setBusy(true);
    try {
      const qualityLabel = qualityItem.label || qualityItem.quality || qualityItem.height ? `${qualityItem.height}p` : 'video';
      const ext = qualityItem.container || 'mp4';
      const title = qualityItem.videoTitle?.replace(/[/\\:*?"<>|]/g, '_').trim().slice(0, 100) || 'video';
      const filename = qualityItem.videoTitle
        ? `${title} [${qualityLabel}].${ext}`
        : `${qualityLabel}.${ext}`;
      await runtimeRequest({ type: 'DOWNLOAD_DIRECT', url: qualityItem.url, filename });
      setSentQualityIds((prev) => new Set(prev).add(qualityItem.id));
      setNotice({ kind: 'success', message: `Download started: ${filename}` });
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function handleSendBestQuality(): Promise<void> {
    // Find best quality from all available items
    const allItems: StreamQualityItem[] = [];
    for (const [, group] of youtubeGroups) {
      const title = getQualityTitle(group);
      const directItems = group.map((c) => candidateToQualityItem(c, title)).filter((q): q is StreamQualityItem => q !== null);
      const varItems = group.flatMap((c) => variantsToQualityItems(c, title));
      allItems.push(...(varItems.length > 0 ? varItems : directItems));
    }
    if (allItems.length === 0) {
      // Non-YouTube candidates
      const pageTitle = videoCandidates[0]?.metadata?.title as string | undefined;
      const directItems = videoCandidates.map((c) => candidateToQualityItem(c, pageTitle)).filter((q): q is StreamQualityItem => q !== null);
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

  if (dismissed || !hasVideo) {
    return null;
  }

  const visibleCandidates =
    filter === 'all' ? videoCandidates : videoCandidates.filter((c) => c.mediaType === filter);
  const handoffableCount = videoCandidates.filter(
    (c) => isHandoffable(c) && isSupportedByRuntime(c, bridge),
  ).length;
  const selectedHandoffable = videoCandidates.some(
    (c) => selected.has(c.id) && isHandoffable(c) && isSupportedByRuntime(c, bridge),
  );

  // --- Collapsed state ---
  if (!expanded) {
    return (
      <main className="nova-popup-mini-mode">
        <header className="nova-mini-header" style={{ padding: '6px 8px', gap: '8px' }}>
          <div className="nova-mini-brand" style={{ gap: '6px' }}>
            <AppLogo />
            <div className="nova-mini-brand-text">
              <h1 className="nova-mini-title">NOVA</h1>
              <span className="nova-mini-status" data-tone={tone}>
                <span className="nova-mini-dot" />
                {videoCandidates.length} {t('popup.handoffable')}
              </span>
            </div>
          </div>

          <div className="nova-mini-actions" style={{ gap: '6px' }}>
            <button
              type="button"
              className="nova-mini-btn nova-mini-btn-send-all"
              disabled={busy || handoffableCount === 0}
              onClick={() => setExpanded(true)}
              title={t('taskActions.sendAll')}
              style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              <Download style={{ width: '13px', height: '13px' }} />
              {t('taskActions.sendAll')}
              <ChevronDown style={{ width: '11px', height: '11px', opacity: 0.7 }} />
            </button>

            <button
              type="button"
              className="nova-mini-btn-close"
              aria-label="Close"
              onClick={() => setDismissed(true)}
              title="Close"
            >
              <X style={{ width: '14px', height: '14px' }} />
            </button>
          </div>
        </header>
      </main>
    );
  }

  // --- Expanded state ---
  return (
    <main className="nova-popup-mini-mode">
      <header className="nova-mini-header">
        <div className="nova-mini-brand">
          <AppLogo />
          <div className="nova-mini-brand-text">
            <h1 className="nova-mini-title">NOVA</h1>
            <span className="nova-mini-status" data-tone={tone}>
              <span className="nova-mini-dot" />
              {bridge?.canSend ? t('popup.ready') : t('popup.needsCheck')}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {/* View mode toggle */}
          {showQualityToggle && (
            <button
              type="button"
              className="nova-mini-btn-text"
              onClick={() => setViewMode(viewMode === 'quality' ? 'list' : 'quality')}
              title={viewMode === 'quality' ? 'Show list view' : 'Show quality view'}
              style={{ gap: '3px', display: 'flex', alignItems: 'center' }}
            >
              {viewMode === 'quality' ? (
                <><List style={{ width: '12px', height: '12px' }} /> List</>
              ) : (
                <><Table2 style={{ width: '12px', height: '12px' }} /> Qualities</>
              )}
            </button>
          )}
          {videoCandidates.length > 0 && (
            <span className="nova-mini-count-badge">{videoCandidates.length}</span>
          )}
          <button
            type="button"
            className="nova-mini-btn-close"
            aria-label="Close"
            onClick={() => setDismissed(true)}
            title="Close"
          >
            <X style={{ width: '14px', height: '14px' }} />
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
      ) : (
        <>
          {/* Quality Table View */}
          {viewMode === 'quality' && (
            <div style={{ overflow: 'auto', maxHeight: '380px', padding: '0 12px' }}>
              {/* YouTube groups */}
              {Array.from(youtubeGroups.entries()).map(([, group]) => {
                const title = getQualityTitle(group);
                const directItems = group
                  .map((c) => candidateToQualityItem(c, title))
                  .filter((q): q is StreamQualityItem => q !== null);
                const variantItems = group.flatMap((c) => variantsToQualityItems(c, title));
                const qualityItems = variantItems.length > 0 ? variantItems : directItems;
                if (qualityItems.length === 0) return null;
                const thumbnail = getThumbnailUrl(group);
                const duration = parseYouTubeDuration(
                  group.find((c) => c.durationSec)?.durationSec,
                );

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

              {/* Non-YouTube page candidates with varying qualities */}
              {youtubeGroups.size === 0 && (() => {
                const pageTitle = videoCandidates[0]?.metadata?.title as string | undefined;
                const directItems = videoCandidates
                  .map((c) => candidateToQualityItem(c, pageTitle))
                  .filter((q): q is StreamQualityItem => q !== null);
                const variantItems = videoCandidates.flatMap((c) => variantsToQualityItems(c, pageTitle));
                const qualityItems = variantItems.length > 0 ? variantItems : directItems;
                if (qualityItems.length < 2) return null;
                const duration = parseYouTubeDuration(videoCandidates.find((c) => c.durationSec)?.durationSec);
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

          {/* List view fallback */}
          {(viewMode === 'list' || nonYouTubeCandidates.length > 0) && (
            <div style={viewMode === 'quality' && nonYouTubeCandidates.length > 0 ? { borderTop: '1px solid var(--nova-border)', paddingTop: 6 } : undefined}>
              {viewMode === 'quality' && nonYouTubeCandidates.length > 0 && (
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--nova-text-muted)', textTransform: 'uppercase', letterSpacing: '.03em', padding: '4px 12px 2px' }}>
                  Other Media
                </div>
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

      <footer className="nova-mini-footer">
        <div className="nova-mini-footer-actions">
          <button
            type="button"
            className="nova-mini-btn nova-mini-btn-scan"
            disabled={busy || !bridge?.canSend}
            onClick={() => void scan()}
          >
            {busy ? '...' : t('taskActions.scan')}
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
        </div>

        {videoCandidates.length > 0 ? (
          <div className="nova-mini-footer-meta">
            <span className="nova-mini-count">
              {videoCandidates.length} {t('popup.handoffable')}
            </span>
          </div>
        ) : null}

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
