import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { novaClient } from '../api/novaClient';
import type { DirectDownloadOptions, MediaDownloadOptions } from '../types/desktop-ui.types';

type JsonRecord = Record<string, unknown>;

export interface EngineCapabilitySnapshot {
  loading: boolean;
  error: string | null;
  raw: unknown;
  directReady: boolean;
  mediaReady: boolean;
  ffmpegReady: boolean;
  postProcessingReady: boolean;
  streamResolverReady: boolean;
  directEngineId: string;
  mediaEngineId: string;
  postProcessorId: string;
  directProtocols: string[];
  directOptionKeys: Set<string>;
  unsupportedDirectOptionKeys: Set<string>;
  mediaOptionKeys: Set<string>;
  unsupportedMediaOptionKeys: Set<string>;
  supportedExternalDownloaders: Set<string>;
  refresh: () => Promise<void>;
  supportsDirectOption: (key: string) => boolean;
  supportsMediaOption: (key: string) => boolean;
  supportsDirectProtocol: (urlOrProtocol: string) => boolean;
  supportsStreamCandidate: (mediaType?: string, source?: string, url?: string) => boolean;
  sanitizeDirectOptions: (options: DirectDownloadOptions) => DirectDownloadOptions;
  sanitizeMediaOptions: (options: MediaDownloadOptions) => MediaDownloadOptions;
  directBlockedReason: (url?: string) => string | null;
  mediaBlockedReason: () => string | null;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asBool(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

function readEngineRecord(root: JsonRecord | undefined, key: string): JsonRecord | undefined {
  const engines = asRecord(root?.engines);
  return asRecord(engines?.[key]);
}

function lowerSet(values: string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

function protocolFromUrlOrProtocol(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed.endsWith(':') && !trimmed.includes('/')) return trimmed.slice(0, -1);
  try {
    return new URL(trimmed).protocol.replace(':', '');
  } catch {
    return trimmed.replace(':', '');
  }
}

const DIRECT_FALLBACK_KEYS = new Set([
  'userAgent', 'referer', 'headers', 'cookies', 'proxy', 'preProxy', 'noproxy',
  'sourceAddress', 'interface', 'ipResolve',
  'proxyType', 'proxyTunnel', 'proxyUser', 'proxyPassword', 'proxyAnyAuth',
  'proxyCaInfo', 'proxyCaPath', 'proxyCert', 'proxyCertType', 'proxyKey',
  'proxyKeyType', 'proxyKeyPassword', 'proxyCiphers', 'proxyTlsMax', 'proxyTlsMin',
  'proxyVerifyPeer', 'proxyVerifyHost',
  'username', 'password', 'authType', 'oauth2Bearer', 'netrc', 'netrcOptional', 'netrcFile',
  'unrestrictedAuth',
  'speedLimitKbs', 'speedLimitBytes', 'lowSpeedLimitBytes', 'speedTimeSec', 'rate',
  'retryCount', 'retryDelaySec', 'retryMaxTimeSec', 'retryAllErrors', 'retryConnRefused',
  'timeoutSec', 'connectTimeoutSec', 'maxRedirs', 'maxFilesize',
  'range', 'etagSave', 'etagCompare', 'timeCond', 'timeValue',
  'remoteTime', 'requestMethod', 'data', 'form',
  'allowOverwrite', 'removeOnError', 'segmented', 'forceSingleConnection',
  'maxConnectionCache', 'maxConnects', 'maxHostConnections', 'maxTotalConnections', 'eventLoop',
  'location', 'failWithBody', 'httpVersion', 'compressed', 'transferEncoding',
  'http09Allowed', 'expect100TimeoutMs',
  'insecure', 'caCert', 'caPath', 'cert', 'certType', 'key', 'keyType', 'pass',
  'tlsMin', 'tlsMax', 'ciphers', 'tls13Ciphers', 'sslReqd',
  'sslOptions', 'sslSessionIdCache', 'crlFile', 'issuerCert', 'pinnedPubKey',
  'ftpCreateDirs', 'proto', 'protoRedir',
  'dohUrl', 'dohSslVerifyPeer', 'dohSslVerifyHost', 'dnsServers', 'dnsInterface', 'dnsCacheTimeoutSec',
  'resolve', 'connectTo',
  'localPortRange', 'tcpNoDelay', 'keepaliveTimeSec',
  'pathAsIs', 'globoff', 'freshConnect', 'forbidReuse', 'maxAgeConn',
  'bufferSize', 'skipExisting',
]);

const MEDIA_FALLBACK_KEYS = new Set([
  'mode',
  'quality',
  'formatSelector',
  'formatSort',
  'audioFormat',
  'bitrate',
  'outputTemplate',
  'playlist',
  'playlistItems',
  'subtitles',
  'subtitleLanguages',
  'autoSubtitles',
  'writeThumbnail',
  'writeInfoJson',
  'writeDescription',
  'proxy',
  'sourceAddress',
  'cookies',
  'cookiesFromBrowser',
  'userAgent',
  'referer',
  'headers',
  'rateLimitKbs',
  'retries',
  'fragmentRetries',
  'concurrentFragments',
  'sleepIntervalSec',
  'maxSleepIntervalSec',
  'downloadSections',
  'matchFilter',
  'ffmpegEnabled',
]);

function filterOptions<T extends object>(options: T, supported: Set<string>): T {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    const emptyString = typeof value === 'string' && value.trim() === '';
    const emptyNumber = typeof value === 'number' && !Number.isFinite(value);
    if (value === undefined || value === null || emptyString || emptyNumber) continue;
    if (supported.has(key)) next[key] = value;
  }
  return next as T;
}

function buildSnapshot(
  raw: unknown,
  loading: boolean,
  error: string | null,
  refresh: () => Promise<void>,
): EngineCapabilitySnapshot {
  const root = asRecord(raw);
  const curl = readEngineRecord(root, 'libcurlMulti') || readEngineRecord(root, 'curl');
  const ytdlp = readEngineRecord(root, 'ytdlp');
  const ffmpeg = readEngineRecord(root, 'ffmpeg');
  const routing = asRecord(root?.routing);

  const directReady = asBool(root?.directReady) || asBool(asRecord(curl?.capabilities)?.directDownloads);
  const mediaReady = asBool(root?.mediaReady) || asBool(ytdlp?.available);
  const ffmpegReady = asBool(ffmpeg?.available);
  const postProcessingReady = asBool(root?.postProcessingReady) || ffmpegReady;

  const directProtocols = asStringArray(root?.directProtocols).length
    ? asStringArray(root?.directProtocols)
    : asStringArray(curl?.protocols);
  const directOptionKeys = new Set(
    asStringArray(curl?.supportedDirectOptionKeys).length
      ? asStringArray(curl?.supportedDirectOptionKeys)
      : Array.from(DIRECT_FALLBACK_KEYS),
  );
  const mediaOptionKeys = new Set(
    asStringArray(ytdlp?.supportedMediaOptionKeys).length
      ? asStringArray(ytdlp?.supportedMediaOptionKeys)
      : Array.from(MEDIA_FALLBACK_KEYS),
  );
  const unsupportedDirectOptionKeys = new Set(asStringArray(curl?.unsupportedDirectOptionKeys));
  const unsupportedMediaOptionKeys = new Set(asStringArray(ytdlp?.unsupportedMediaOptionKeys));
  const enabledDirectOptionKeys = new Set(
    Array.from(directOptionKeys).filter((key) => !unsupportedDirectOptionKeys.has(key)),
  );
  const enabledMediaOptionKeys = new Set(
    Array.from(mediaOptionKeys).filter((key) => !unsupportedMediaOptionKeys.has(key)),
  );
  const directProtocolSet = lowerSet(directProtocols);
  const supportedExternalDownloaders = new Set(asStringArray(ytdlp?.supportedExternalDownloaders));

  const snapshot: EngineCapabilitySnapshot = {
    loading,
    error,
    raw,
    directReady,
    mediaReady,
    ffmpegReady,
    postProcessingReady,
    streamResolverReady: mediaReady && postProcessingReady,
    directEngineId:
      typeof routing?.directHttpHttpsFtp === 'string'
        ? routing.directHttpHttpsFtp
        : directReady
          ? 'libcurl-multi'
          : 'unavailable',
    mediaEngineId:
      typeof routing?.webMediaAndPlaylists === 'string'
        ? routing.webMediaAndPlaylists
        : mediaReady
          ? 'media engine'
          : 'unavailable',
    postProcessorId:
      typeof routing?.mergeRemuxExtractSubtitles === 'string'
        ? routing.mergeRemuxExtractSubtitles
        : postProcessingReady
          ? 'ffmpeg'
          : 'unavailable',
    directProtocols,
    directOptionKeys,
    unsupportedDirectOptionKeys,
    mediaOptionKeys,
    unsupportedMediaOptionKeys,
    supportedExternalDownloaders,
    refresh,
    supportsDirectOption: (key: string) => directReady && enabledDirectOptionKeys.has(key),
    supportsMediaOption: (key: string) => mediaReady && enabledMediaOptionKeys.has(key),
    supportsDirectProtocol: (urlOrProtocol: string) => {
      if (!directReady) return false;
      const protocol = protocolFromUrlOrProtocol(urlOrProtocol);
      return Boolean(protocol && directProtocolSet.has(protocol));
    },
    supportsStreamCandidate: (mediaType?: string, source?: string, candidateUrl?: string) => {
      if (!mediaReady || !postProcessingReady) return false;
      const marker = `${mediaType || ''} ${source || ''} ${candidateUrl || ''}`.toLowerCase();
      return (
        marker.includes('hls') ||
        marker.includes('dash') ||
        marker.includes('m3u8') ||
        marker.includes('mpd') ||
        marker.includes('manifest')
      );
    },
    sanitizeDirectOptions: (options: DirectDownloadOptions) => filterOptions(options, enabledDirectOptionKeys),
    sanitizeMediaOptions: (options: MediaDownloadOptions) => filterOptions(options, enabledMediaOptionKeys),
    directBlockedReason: (candidateUrl?: string) => {
      if (!directReady) return 'The runtime linked libcurl direct engine is not ready.';
      if (candidateUrl) {
        const protocol = protocolFromUrlOrProtocol(candidateUrl) || 'unknown';
        if (!protocol || !directProtocolSet.has(protocol)) {
          return `Protocol ${protocol} is not enabled in the linked libcurl build.`;
        }
      }
      return null;
    },
    mediaBlockedReason: () => {
      if (!mediaReady) return 'Media engine is not ready.';
      if (!postProcessingReady) return 'FFmpeg is required for complete media stream handling and post-processing.';
      return null;
    },
  };
  return snapshot;
}

const EngineCapabilityContext = createContext<EngineCapabilitySnapshot | null>(null);

// Retry schedule: fast when daemon is unreachable so capabilities appear immediately
// after the daemon becomes ready; slow once loaded.
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 8_000;
const HEALTHY_POLL_MS = 60_000;

export const EngineCapabilityProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [raw, setRaw] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const capabilities = await novaClient.engineCapabilities();
      setRaw(capabilities);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Engine capabilities are unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Use an object so post-await guards are opaque to static analysis.
    const ctrl = { cancelled: false };
    let timer: number | null = null;
    let retryDelay = RETRY_MIN_MS;
    let everSucceeded = false;

    const tick = async () => {
      if (ctrl.cancelled) return;
      setLoading(true);
      try {
        const capabilities = await novaClient.engineCapabilities();
        // ctrl.cancelled may flip to true during the await (cleanup unmount).
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (ctrl.cancelled) return;
        setRaw(capabilities);
        setError(null);
        everSucceeded = true;
        retryDelay = RETRY_MIN_MS;
        timer = window.setTimeout(() => { void tick(); }, HEALTHY_POLL_MS);
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (ctrl.cancelled) return;
        setError(err instanceof Error ? err.message : 'Engine capabilities are unavailable.');
        const next = everSucceeded ? HEALTHY_POLL_MS : Math.min(retryDelay * 2, RETRY_MAX_MS);
        retryDelay = next;
        timer = window.setTimeout(() => { void tick(); }, next);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!ctrl.cancelled) setLoading(false);
      }
    };

    void tick();

    return () => {
      ctrl.cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  const value = useMemo(() => buildSnapshot(raw, loading, error, refresh), [raw, loading, error, refresh]);

  return <EngineCapabilityContext.Provider value={value}>{children}</EngineCapabilityContext.Provider>;
};

export function useEngineCapabilities(): EngineCapabilitySnapshot {
  const context = useContext(EngineCapabilityContext);
  if (context) return context;
  return buildSnapshot(null, true, 'EngineCapabilityProvider is not mounted.', async () => {});
}
