declare module 'm3u8-parser' {
  export class Parser {
    constructor(options?: Record<string, unknown>);
    push(input: string): void;
    end(): void;
    manifest: {
      playlists?: Array<{
        uri?: string;
        attributes?: {
          BANDWIDTH?: number;
          RESOLUTION?: { width?: number; height?: number };
          CODECS?: string;
        };
      }>;
      mediaGroups?: Record<string, Record<string, Record<string, Record<string, { uri?: string; language?: string; default?: boolean }>>>>;
      segments?: Array<{ duration?: number }>;
    };
  }
}

declare module 'mpd-parser' {
  export function parse(input: string, options: { manifestUri: string; eventHandler?: (event: { type: string; message: string }) => void; previousManifest?: unknown }): {
    duration?: number;
    playlists?: Array<{
      uri?: string;
      attributes?: {
        BANDWIDTH?: number;
        RESOLUTION?: { width?: number; height?: number };
        CODECS?: string;
      };
      sidx?: unknown;
      segments?: Array<{ uri?: string; resolvedUri?: string }>;
    }>;
    mediaGroups?: Record<string, unknown>;
  };
}
