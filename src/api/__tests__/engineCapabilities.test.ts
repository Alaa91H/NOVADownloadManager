import { describe, expect, it } from 'vitest';
import { parseEngineCapabilitiesResponse } from '../engineCapabilities';

const engine = { available: true, protocols: ['http', 'https'] };

function validCapabilities() {
  return {
    status: 'connected',
    allReady: true,
    directReady: true,
    mediaExtractionReady: true,
    streamingReady: true,
    mediaReady: true,
    postProcessingReady: true,
    directProtocols: ['http', 'https', 'ftp'],
    compatibilityMode: 'runtime-verified-capabilities',
    mediaApi: {
      resolve: '/api/media/resolve',
      probe: '/api/media/probe',
      download: '/api/media/download',
      postprocessStatus: '/api/media/postprocess/status',
    },
    routing: {
      directHttpHttpsFtp: 'libcurl-multi',
      webMediaAndPlaylists: 'nova-media-engine',
      mergeRemuxExtractSubtitles: 'nova-media-postprocess',
      torrentMagnet: null,
    },
    engines: {
      curl: engine,
      libcurlMulti: engine,
      media: engine,
      ffmpeg: engine,
    },
  };
}

describe('engine capabilities contract', () => {
  it('accepts the runtime-verified daemon response shape', () => {
    const capabilities = parseEngineCapabilitiesResponse(validCapabilities());

    expect(capabilities.directProtocols).toEqual(['http', 'https', 'ftp']);
    expect(capabilities.engines.libcurlMulti.available).toBe(true);
    expect(capabilities.mediaExtractionReady).toBe(true);
    expect(capabilities.streamingReady).toBe(true);
    expect(capabilities.mediaApi.resolve).toBe('/api/media/resolve');
    expect(capabilities.mediaApi.download).toBe('/api/media/download');
    expect(capabilities.routing.torrentMagnet).toBeNull();
  });

  it('rejects capability responses without required readiness flags', () => {
    const response = validCapabilities();
    delete (response as Partial<typeof response>).mediaExtractionReady;

    expect(() => parseEngineCapabilitiesResponse(response)).toThrow(
      'mediaExtractionReady must be a boolean',
    );
  });

  it('rejects responses from an incompatible contract mode', () => {
    const response = { ...validCapabilities(), compatibilityMode: 'legacy' };

    expect(() => parseEngineCapabilitiesResponse(response)).toThrow('unsupported compatibility mode');
  });
});
