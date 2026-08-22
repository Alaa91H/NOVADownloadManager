import { describe, expect, it } from 'vitest';
import { parseEngineCapabilitiesResponse } from '../engineCapabilities';

const engine = { available: true, protocols: ['http', 'https'] };

function validCapabilities() {
  return {
    status: 'connected',
    allReady: true,
    directReady: true,
    mediaReady: true,
    postProcessingReady: true,
    directProtocols: ['http', 'https', 'ftp'],
    compatibilityMode: 'runtime-verified-capabilities',
    routing: {
      directHttpHttpsFtp: 'libcurl-multi',
      webMediaAndPlaylists: 'yt-dlp',
      mergeRemuxExtractSubtitles: 'ffmpeg via yt-dlp',
      torrentMagnet: null,
    },
    engines: {
      curl: engine,
      libcurlMulti: engine,
      ytdlp: engine,
      ffmpeg: engine,
    },
  };
}

describe('engine capabilities contract', () => {
  it('accepts the runtime-verified daemon response shape', () => {
    const capabilities = parseEngineCapabilitiesResponse(validCapabilities());

    expect(capabilities.directProtocols).toEqual(['http', 'https', 'ftp']);
    expect(capabilities.engines.libcurlMulti.available).toBe(true);
    expect(capabilities.routing.torrentMagnet).toBeNull();
  });

  it('rejects capability responses without required readiness flags', () => {
    const response = validCapabilities();
    delete (response as Partial<typeof response>).directReady;

    expect(() => parseEngineCapabilitiesResponse(response)).toThrow('directReady must be a boolean');
  });

  it('rejects responses from an incompatible contract mode', () => {
    const response = { ...validCapabilities(), compatibilityMode: 'legacy' };

    expect(() => parseEngineCapabilitiesResponse(response)).toThrow('unsupported compatibility mode');
  });
});
