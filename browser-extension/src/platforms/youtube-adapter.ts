import { PlatformAdapter, PlatformMediaResult } from './base-platform-adapter';
import type { Candidate } from '../contracts/candidate.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

const PROTOCOL = 'https';
const YOUTUBE_HOSTS: ReadonlyArray<string> = ['www.youtube.com', 'm.youtube.com', 'youtube.com', 'youtu.be', 'music.youtube.com'];
const YOUTUBE_CDN: ReadonlyArray<string> = ['*.googlevideo.com', '*.ytimg.com', '*.youtube.com'];

const VIDEO_ID_RE = /(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
const VIDEO_PLAYBACK_RE = /\/videoplayback\?/i;
const QUALITY_LABEL_RE = /^(\d+p)(\d*)\s*(HDR|60|5\.1ch|HQ)?/i;

const ITAG_QUALITY: Record<number, { quality: string; ext: string; fps?: number; hdr?: boolean }> = {
  5: { quality: '144p', ext: 'flv' }, 6: { quality: '240p', ext: 'flv' }, 13: { quality: '144p', ext: '3gp' },
  17: { quality: '144p', ext: '3gp' }, 18: { quality: '360p', ext: 'mp4' }, 22: { quality: '720p', ext: 'mp4' },
  34: { quality: '360p', ext: 'flv' }, 35: { quality: '480p', ext: 'flv' }, 36: { quality: '240p', ext: '3gp' },
  37: { quality: '1080p', ext: 'mp4' }, 38: { quality: '3072p', ext: 'mp4' }, 43: { quality: '360p', ext: 'webm' },
  44: { quality: '480p', ext: 'webm' }, 45: { quality: '720p', ext: 'webm' }, 46: { quality: '1080p', ext: 'webm' },
  59: { quality: '480p', ext: 'mp4' }, 78: { quality: '480p', ext: 'mp4' }, 82: { quality: '360p', ext: 'mp4' },
  83: { quality: '480p', ext: 'mp4' }, 84: { quality: '720p', ext: 'mp4' }, 85: { quality: '1080p', ext: 'mp4' },
  91: { quality: '144p', ext: 'mp4' }, 92: { quality: '240p', ext: 'mp4' }, 93: { quality: '360p', ext: 'mp4' },
  94: { quality: '480p', ext: 'mp4' }, 95: { quality: '720p', ext: 'mp4' }, 96: { quality: '1080p', ext: 'mp4' },
  100: { quality: '360p', ext: 'webm' }, 101: { quality: '480p', ext: 'webm' }, 102: { quality: '720p', ext: 'webm' },
  120: { quality: '720p', ext: 'webm' }, 127: { quality: '144p', ext: 'ts' }, 128: { quality: '240p', ext: 'ts' },
  132: { quality: '240p', ext: 'mp4' }, 133: { quality: '240p', ext: 'mp4' }, 134: { quality: '360p', ext: 'mp4' },
  135: { quality: '480p', ext: 'mp4' }, 136: { quality: '720p', ext: 'mp4' }, 137: { quality: '1080p', ext: 'mp4' },
  138: { quality: '2160p', ext: 'mp4' }, 139: { quality: '48kbps', ext: 'm4a' }, 140: { quality: '128kbps', ext: 'm4a' },
  141: { quality: '256kbps', ext: 'm4a' }, 160: { quality: '144p', ext: 'mp4' }, 167: { quality: '360p', ext: 'webm' },
  168: { quality: '480p', ext: 'webm' }, 169: { quality: '720p', ext: 'webm' }, 170: { quality: '1080p', ext: 'webm' },
  171: { quality: '128kbps', ext: 'ogg' }, 172: { quality: '256kbps', ext: 'ogg' }, 218: { quality: '480p', ext: 'webm' },
  219: { quality: '480p', ext: 'webm' }, 242: { quality: '240p', ext: 'webm' }, 243: { quality: '360p', ext: 'webm' },
  244: { quality: '480p', ext: 'webm' }, 245: { quality: '480p', ext: 'webm' }, 246: { quality: '480p', ext: 'webm' },
  247: { quality: '720p', ext: 'webm' }, 248: { quality: '1080p', ext: 'webm' }, 249: { quality: '48kbps', ext: 'opus' },
  250: { quality: '64kbps', ext: 'opus' }, 251: { quality: '160kbps', ext: 'opus' }, 258: { quality: '720p', ext: 'mp4' },
  264: { quality: '1440p', ext: 'mp4' }, 266: { quality: '2160p', ext: 'mp4' }, 271: { quality: '1440p', ext: 'webm' },
  272: { quality: '2160p', ext: 'webm' }, 278: { quality: '144p', ext: 'webm' }, 298: { quality: '720p60', ext: 'mp4', fps: 60 },
  299: { quality: '1080p60', ext: 'mp4', fps: 60 }, 302: { quality: '720p60', ext: 'webm', fps: 60 },
  303: { quality: '1080p60', ext: 'webm', fps: 60 }, 308: { quality: '1440p60', ext: 'webm', fps: 60 },
  313: { quality: '2160p', ext: 'webm' }, 315: { quality: '2160p60', ext: 'webm', fps: 60 },
  325: { quality: '360p', ext: 'ts' }, 326: { quality: '480p', ext: 'ts' }, 327: { quality: '720p', ext: 'ts' },
  328: { quality: '1080p', ext: 'ts' }, 330: { quality: '144p', ext: 'ts' }, 331: { quality: '240p', ext: 'ts' },
  332: { quality: '360p', ext: 'ts' }, 333: { quality: '480p', ext: 'ts' }, 334: { quality: '720p', ext: 'ts' },
  335: { quality: '1080p', ext: 'ts' }, 336: { quality: '1440p', ext: 'ts' }, 337: { quality: '2160p', ext: 'ts' },
  394: { quality: '144p', ext: 'mp4' }, 395: { quality: '240p', ext: 'mp4' }, 396: { quality: '360p', ext: 'mp4' },
  397: { quality: '480p', ext: 'mp4' }, 398: { quality: '720p', ext: 'mp4' }, 399: { quality: '1080p', ext: 'mp4' },
  400: { quality: '1440p', ext: 'mp4' }, 401: { quality: '2160p', ext: 'mp4' }, 402: { quality: '4320p', ext: 'mp4' },
  571: { quality: '384kbps', ext: 'm4a' },
  597: { quality: '480p', ext: 'ts' }, 598: { quality: '720p', ext: 'ts' }, 599: { quality: '1080p', ext: 'ts' },
  600: { quality: '1440p', ext: 'ts' }, 601: { quality: '2160p', ext: 'ts' },
  602: { quality: '144p', ext: 'mp4' }, 603: { quality: '240p', ext: 'mp4' }, 604: { quality: '360p', ext: 'mp4' },
  605: { quality: '480p', ext: 'mp4' }, 606: { quality: '720p', ext: 'mp4' }, 607: { quality: '1080p', ext: 'mp4' },
  608: { quality: '1440p', ext: 'mp4' }, 609: { quality: '2160p', ext: 'mp4' }, 610: { quality: '4320p', ext: 'mp4' },
  611: { quality: '1080p60', ext: 'mp4', fps: 60 }, 612: { quality: '720p60', ext: 'mp4', fps: 60 },
  613: { quality: '2160p60', ext: 'mp4', fps: 60 }, 614: { quality: '1080p60 HDR', ext: 'mp4', fps: 60, hdr: true },
  615: { quality: '2160p60 HDR', ext: 'mp4', fps: 60, hdr: true },
  616: { quality: '1440p60', ext: 'mp4', fps: 60 }, 617: { quality: '1440p60 HDR', ext: 'mp4', fps: 60, hdr: true },
  618: { quality: '1080p60 HDR', ext: 'mp4', fps: 60, hdr: true },
  619: { quality: '2160p60 HDR', ext: 'mp4', fps: 60, hdr: true },
  620: { quality: '4320p60', ext: 'mp4', fps: 60 }, 621: { quality: '4320p60 HDR', ext: 'mp4', fps: 60, hdr: true },
  622: { quality: '1080p60 5.1ch', ext: 'mp4', fps: 60 }, 623: { quality: '720p60 5.1ch', ext: 'mp4', fps: 60 },
  624: { quality: '2160p60 5.1ch', ext: 'mp4', fps: 60 },
  625: { quality: '144p', ext: 'mp4' }, 626: { quality: '240p', ext: 'mp4' }, 627: { quality: '360p', ext: 'mp4' },
  628: { quality: '480p', ext: 'mp4' }, 629: { quality: '720p', ext: 'mp4' }, 630: { quality: '1080p', ext: 'mp4' },
  631: { quality: '1440p', ext: 'mp4' }, 632: { quality: '2160p', ext: 'mp4' },
  633: { quality: '48kbps', ext: 'opus' }, 634: { quality: '64kbps', ext: 'opus' }, 635: { quality: '96kbps', ext: 'opus' },
  636: { quality: '128kbps', ext: 'opus' }, 637: { quality: '160kbps', ext: 'm4a' },
  638: { quality: '160kbps', ext: 'opus' }, 639: { quality: '192kbps', ext: 'opus' },
  640: { quality: '256kbps', ext: 'm4a' }, 641: { quality: '256kbps', ext: 'opus' },
  642: { quality: '320kbps', ext: 'opus' },
  643: { quality: '144p', ext: 'mp4' }, 644: { quality: '240p', ext: 'mp4' }, 645: { quality: '360p', ext: 'mp4' },
  646: { quality: '480p', ext: 'mp4' }, 647: { quality: '720p', ext: 'mp4' }, 648: { quality: '1080p', ext: 'mp4' },
  649: { quality: '1440p', ext: 'mp4' }, 650: { quality: '2160p', ext: 'mp4' }, 651: { quality: '4320p', ext: 'mp4' },
  652: { quality: '144p HDR', ext: 'mp4', hdr: true }, 653: { quality: '240p HDR', ext: 'mp4', hdr: true },
  654: { quality: '360p HDR', ext: 'mp4', hdr: true }, 655: { quality: '480p HDR', ext: 'mp4', hdr: true },
  656: { quality: '720p HDR', ext: 'mp4', hdr: true }, 657: { quality: '1080p HDR', ext: 'mp4', hdr: true },
  658: { quality: '1440p HDR', ext: 'mp4', hdr: true }, 659: { quality: '2160p HDR', ext: 'mp4', hdr: true },
};

function parseQualityLabel(label: string): { quality: string; fps?: number; hdr?: boolean } | undefined {
  const m = label.match(QUALITY_LABEL_RE);
  if (!m) return undefined;
  const base = m[1]!;
  const fps = m[3]?.includes('60') ? 60 : undefined;
  const hdr = m[3]?.includes('HDR') ? true : undefined;
  return { quality: base, fps, hdr };
}

function hostnameFromUrl(url: string): string | undefined {
  try { return new URL(url).hostname; } catch { return undefined; }
}

export class YoutubeAdapter extends PlatformAdapter {
  readonly id = 'youtube';
  readonly name = 'YouTube';
  override readonly hosts = YOUTUBE_HOSTS;
  override readonly cdnPatterns = YOUTUBE_CDN;

  extractFromScan(content: ContentScanResponse): PlatformMediaResult[] {
    const results: PlatformMediaResult[] = [];

    this.extractPlayerResponse(content.html, results);
    this.extractPlayerResponseAlt(content.html, results);
    this.extractItagUrls(content.html, results);
    this.extractVideoInfoFromHtml(content.html, results);
    this.extractPlaylistItems(content.html, results);
    this.extractFromLinks(content.links, results);

    return results;
  }

  private extractPlayerResponse(html: string, results: PlatformMediaResult[]): void {
    const patterns = [
      /ytInitialPlayerResponse\s*=\s*({.+?});/s,
      /player_response['"]?\s*[:=]\s*['"](.+?)['"]/s,
    ];
    let rawJson: string | undefined;
    for (const re of patterns) {
      const m = html.match(re);
      if (!m?.[1]) continue;
      rawJson = m[1];
      break;
    }
    if (!rawJson) return;
    try {
      const data = JSON.parse(rawJson);
      const formats = [
        ...(data.streamingData?.formats ?? []),
        ...(data.streamingData?.adaptiveFormats ?? []),
      ] as Array<Record<string, unknown>>;

      for (const fmt of formats) {
        const url = this.resolveFormatUrl(fmt);
        const mime = fmt.mimeType as string | undefined;
        const qualityLabel = fmt.qualityLabel as string | undefined;
        const itag = fmt.itag as number | undefined;
        const contentLength = fmt.contentLength as string | undefined;
        const bitrate = fmt.bitrate as number | undefined;
        const fpso = fmt.fps as number | undefined;
        const width = fmt.width as number | undefined;
        const height = fmt.height as number | undefined;
        const codecs = mime ? mime.match(/codecs="([^"]+)"/)?.[1] : undefined;

        if (!url && !(fmt.signatureCipher || fmt.cipher)) continue;

        let quality: string | undefined;
        let fps: number | undefined;
        let hdr = false;
        if (qualityLabel) {
          const parsed = parseQualityLabel(qualityLabel);
          quality = parsed?.quality;
          fps = parsed?.fps;
          hdr = parsed?.hdr ?? false;
        } else if (itag !== undefined) {
          const entry = ITAG_QUALITY[itag];
          if (entry) {
            quality = entry.quality;
            fps = entry.fps;
            hdr = entry.hdr ?? false;
          }
        }

        const resultUrl = url ?? this.buildCipheredUrl(fmt);
        if (!resultUrl) continue;

        const result: PlatformMediaResult = {
          url: resultUrl,
          type: mime?.startsWith('audio') ? 'audio' : 'video',
          quality,
          mimeType: mime?.split(';')[0]?.split(',')[0],
          width,
          height,
          confidenceDelta: 25,
          metadata: {
            itag: String(itag ?? ''),
            contentLength: contentLength ?? '',
            bitrate: String(bitrate ?? ''),
            fps: String(fps ?? ''),
            hdr: String(hdr),
            codecs: codecs ?? '',
            source: 'ytInitialPlayerResponse',
          },
        };
        if (fps) result.metadata!.fps = String(fps);
        if (hdr) result.metadata!.hdr = '1';
        if (fpso) result.metadata!.fpso = String(fpso);

        results.push(result);
      }

      if (data.videoDetails) {
        const vd = data.videoDetails as Record<string, unknown>;
        const videoId = vd.videoId as string | undefined;
        const title = vd.title as string | undefined;
        if (videoId && title) {
          for (const r of results) {
            if (!r.metadata) r.metadata = {};
            r.metadata.videoId = videoId;
            r.metadata.title = title;
          }
        }
      }
    } catch { /* JSON parse failure */ }
  }

  private extractPlayerResponseAlt(html: string, results: PlatformMediaResult[]): void {
    const m = html.match(/window\.ytInitialPlayerResponse\s*=\s*JSON\.parse\('(.+?)'\);/s);
    if (!m?.[1]) return;
    try {
      const raw = m[1].replace(/\\'/g, "'").replace(/\\\\"/g, '"').replace(/\\"/g, '"').replace(/\\\\n/g, '\\n').replace(/\\\\x/g, '\\x').replace(/\\\\u/g, '\\u').replace(/\\\\/g, '\\');
      const data = JSON.parse(raw);
      if (!data.streamingData) return;
      const formats = [
        ...(data.streamingData.formats ?? []),
        ...(data.streamingData.adaptiveFormats ?? []),
      ] as Array<Record<string, unknown>>;
      for (const fmt of formats) {
        const url = this.resolveFormatUrl(fmt);
        if (!url) continue;
        if (results.some((r) => r.url === url)) continue;
        const mime = fmt.mimeType as string | undefined;
        const qualityLabel = fmt.qualityLabel as string | undefined;
        const itag = fmt.itag as number | undefined;
        const contentLength = fmt.contentLength as string | undefined;
        const width = fmt.width as number | undefined;
        const height = fmt.height as number | undefined;

        let quality: string | undefined;
        if (qualityLabel) {
          const parsed = parseQualityLabel(qualityLabel);
          quality = parsed?.quality;
        } else if (itag !== undefined) {
          quality = ITAG_QUALITY[itag]?.quality;
        }

        results.push({
          url,
          type: mime?.startsWith('audio') ? 'audio' : 'video',
          quality,
          mimeType: mime?.split(';')[0]?.split(',')[0],
          width,
          height,
          confidenceDelta: 25,
          metadata: {
            itag: String(itag ?? ''),
            contentLength: contentLength ?? '',
            source: 'ytInitialPlayerResponse-jsonparse',
          },
        });
      }
    } catch { /* JSON parse failure */ }
  }

  private resolveFormatUrl(fmt: Record<string, unknown>): string | undefined {
    let url = fmt.url as string | undefined;
    if (!url) {
      const cipher = (fmt.signatureCipher ?? fmt.cipher) as string | undefined;
      if (cipher) {
        for (const part of cipher.split('&')) {
          const [key, val] = part.split('=');
          if (key === 'url' && val) url = decodeURIComponent(val);
        }
      }
    }
    return url;
  }

  private buildCipheredUrl(fmt: Record<string, unknown>): string | undefined {
    const cipher = (fmt.signatureCipher ?? fmt.cipher) as string | undefined;
    if (!cipher) return undefined;
    const params = new URLSearchParams(cipher);
    return params.get('url') ?? undefined;
  }

  private extractItagUrls(html: string, results: PlatformMediaResult[]): void {
    const seen = new Set(results.map((r) => r.url));
    if (!VIDEO_PLAYBACK_RE.test(html)) return;
    const lines = html.split('\n').filter((l) => VIDEO_PLAYBACK_RE.test(l));
    for (const line of lines) {
      const urlMatch = line.match(/(https?:\/\/[^\s"'<>]+videoplayback[^\s"'<>]*)/i);
      if (!urlMatch) continue;
      const rawUrl = urlMatch[1];
      if (!rawUrl) continue;
      const url = rawUrl.replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&');
      if (seen.has(url)) continue;
      seen.add(url);
      const itagMatch = url.match(/itag=(\d+)/i);
      const itag = itagMatch ? parseInt(itagMatch[1]!, 10) : undefined;
      const entry = itag !== undefined ? ITAG_QUALITY[itag] : undefined;
      const quality = entry?.quality;
      const isAudio = url.includes('mime=audio');
      results.push({
        url,
        type: isAudio ? 'audio' : 'video',
        quality,
        mimeType: isAudio ? 'audio/mp4' : 'video/mp4',
        confidenceDelta: 20,
        metadata: {
          itag: String(itag ?? ''),
          source: 'videoplayback',
          fps: entry?.fps ? String(entry.fps) : '',
          hdr: entry?.hdr ? '1' : '',
        },
      });
    }
  }

  private extractVideoInfoFromHtml(html: string, results: PlatformMediaResult[]): void {
    const videoIdMatch = html.match(VIDEO_ID_RE);
    const videoId = videoIdMatch?.[1];
    if (!videoId) return;

    let title: string | undefined;
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch?.[1]) {
      title = titleMatch[1].replace(/\s*-\s*YouTube\s*$/i, '').trim();
    }

    const videoUrl = `${PROTOCOL}://www.youtube.com/watch?v=${videoId}`;
    if (!results.some((r) => r.url === videoUrl)) {
      results.push({
        url: videoUrl,
        type: 'video',
        originalUrl: videoUrl,
        metadata: { videoId, title: title ?? '', source: 'video-info' },
      });
    }

    for (const r of results) {
      if (!r.metadata) r.metadata = {};
      if (!r.metadata.videoId) r.metadata.videoId = videoId;
      if (title && !r.metadata.title) r.metadata.title = title;
    }
  }

  private extractPlaylistItems(html: string, results: PlatformMediaResult[]): void {
    const playlistVideoIdRe = /"playlistVideoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/g;
    const titleRe = /"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)"/;
    const seenVideoIds = new Set(results.map((r) => r.metadata?.videoId).filter(Boolean));
    const playlistVideoIds = new Set<string>();
    for (const match of html.matchAll(playlistVideoIdRe)) {
      const vid = match[1];
      if (vid && !seenVideoIds.has(vid)) playlistVideoIds.add(vid);
    }
    if (playlistVideoIds.size === 0) return;
    const titleMatch = html.match(titleRe);
    const playlistTitle = titleMatch?.[1];
    for (const vid of playlistVideoIds) {
      const watchUrl = `${PROTOCOL}://www.youtube.com/watch?v=${vid}`;
      if (!results.some((r) => r.url === watchUrl)) {
        results.push({
          url: watchUrl,
          type: 'video',
          originalUrl: watchUrl,
          confidenceDelta: 15,
          metadata: { videoId: vid, source: 'playlist', title: playlistTitle ?? '' },
        });
      }
    }
  }

  private extractFromLinks(links: ContentScanResponse['links'], results: PlatformMediaResult[]): void {
    if (!links) return;
    const seenUrls = new Set(results.map((r) => r.url));
    for (const link of links) {
      if (!link.url || seenUrls.has(link.url)) continue;
      if (VIDEO_PLAYBACK_RE.test(link.url)) {
        seenUrls.add(link.url);
        const itagMatch = link.url.match(/itag=(\d+)/i);
        const itag = itagMatch ? parseInt(itagMatch[1]!, 10) : undefined;
        const entry = itag !== undefined ? ITAG_QUALITY[itag] : undefined;
        results.push({
          url: link.url,
          type: link.url.includes('mime=audio') ? 'audio' : 'video',
          quality: entry?.quality,
          confidenceDelta: 20,
          metadata: { itag: String(itag ?? ''), source: 'dom-link-videoplayback' },
        });
      } else {
        const hostname = hostnameFromUrl(link.url);
        if (hostname && this.cdnPatterns.some((p) => hostname.endsWith(p.slice(1)))) {
          seenUrls.add(link.url);
          results.push({
            url: link.url,
            type: /\.(mp4|m3u8|mpd|webm)/i.test(link.url) ? 'video' : 'image',
            confidenceDelta: 15,
            metadata: { source: 'dom-link-cdn', tag: link.tag },
          });
        }
      }
    }
  }

  override adjustConfidence(candidate: Candidate): number {
    const url = candidate.url ?? '';
    if (VIDEO_PLAYBACK_RE.test(url)) return Math.max(candidate.confidence, 75);
    if (/googlevideo\.com/.test(url)) return Math.max(candidate.confidence, 60);
    if (/youtube\.com\/watch/.test(url)) return Math.max(candidate.confidence, 50);
    return candidate.confidence + 10;
  }
}
