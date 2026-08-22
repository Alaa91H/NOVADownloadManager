export type CapabilityStatus = 'connected' | 'degraded';

type JsonRecord = Record<string, unknown>;

export interface EngineRuntimeCapabilities {
  available?: boolean;
  protocols?: string[];
  supportedDirectOptionKeys?: string[];
  unsupportedDirectOptionKeys?: string[];
  supportedMediaOptionKeys?: string[];
  unsupportedMediaOptionKeys?: string[];
  supportedExternalDownloaders?: string[];
  capabilities?: JsonRecord;
  [key: string]: unknown;
}

export interface EngineRoutingCapabilities {
  directHttpHttpsFtp?: string | null;
  webMediaAndPlaylists?: string | null;
  mergeRemuxExtractSubtitles?: string | null;
  torrentMagnet?: string | null;
}

export interface EngineCapabilitiesResponse {
  status: CapabilityStatus;
  allReady: boolean;
  directReady: boolean;
  mediaReady: boolean;
  postProcessingReady: boolean;
  directProtocols: string[];
  compatibilityMode: 'runtime-verified-capabilities';
  routing: EngineRoutingCapabilities;
  engines: {
    curl: EngineRuntimeCapabilities;
    libcurlMulti: EngineRuntimeCapabilities;
    ytdlp: EngineRuntimeCapabilities;
    ffmpeg: EngineRuntimeCapabilities;
  };
}

function asRecord(value: unknown, path: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid engine capabilities response: ${path} must be an object.`);
  }
  return value as JsonRecord;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid engine capabilities response: ${path} must be a boolean.`);
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid engine capabilities response: ${path} must be a non-empty string.`);
  }
  return value;
}

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid engine capabilities response: ${path} must be a string array.`);
  }
  return value as string[];
}

function asOptionalEngineId(value: unknown, path: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return asString(value, path);
}

function parseRouting(value: unknown): EngineRoutingCapabilities {
  const routing = asRecord(value, 'routing');
  return {
    directHttpHttpsFtp: asOptionalEngineId(routing.directHttpHttpsFtp, 'routing.directHttpHttpsFtp'),
    webMediaAndPlaylists: asOptionalEngineId(routing.webMediaAndPlaylists, 'routing.webMediaAndPlaylists'),
    mergeRemuxExtractSubtitles: asOptionalEngineId(
      routing.mergeRemuxExtractSubtitles,
      'routing.mergeRemuxExtractSubtitles',
    ),
    torrentMagnet: asOptionalEngineId(routing.torrentMagnet, 'routing.torrentMagnet'),
  };
}

export function parseEngineCapabilitiesResponse(value: unknown): EngineCapabilitiesResponse {
  const root = asRecord(value, 'root');
  const status = asString(root.status, 'status');
  if (status !== 'connected' && status !== 'degraded') {
    throw new Error('Invalid engine capabilities response: status must be connected or degraded.');
  }

  const compatibilityMode = asString(root.compatibilityMode, 'compatibilityMode');
  if (compatibilityMode !== 'runtime-verified-capabilities') {
    throw new Error('Invalid engine capabilities response: unsupported compatibility mode.');
  }

  const engines = asRecord(root.engines, 'engines');
  return {
    status,
    allReady: asBoolean(root.allReady, 'allReady'),
    directReady: asBoolean(root.directReady, 'directReady'),
    mediaReady: asBoolean(root.mediaReady, 'mediaReady'),
    postProcessingReady: asBoolean(root.postProcessingReady, 'postProcessingReady'),
    directProtocols: asStringArray(root.directProtocols, 'directProtocols'),
    compatibilityMode,
    routing: parseRouting(root.routing),
    engines: {
      curl: asRecord(engines.curl, 'engines.curl'),
      libcurlMulti: asRecord(engines.libcurlMulti, 'engines.libcurlMulti'),
      ytdlp: asRecord(engines.ytdlp, 'engines.ytdlp'),
      ffmpeg: asRecord(engines.ffmpeg, 'engines.ffmpeg'),
    },
  };
}
