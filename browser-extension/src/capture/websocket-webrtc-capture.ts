import type { Candidate } from '../contracts/candidate.schema';
import type { CaptureContext } from './capture-context';
import type { CapturePlugin } from './capture-plugin';
import { classifyByUrl } from '../pipeline/mime-detector';
import { extensionOf } from '../utils/url';

const MEDIA_STREAM_EXTENSIONS = /\.(?:m3u8|mpd|ts|m4s|mp4|webm|mkv|flv|aac|mp3|ogg|opus|wav)(?:$|[?#])/i;
const WS_MEDIA_PATTERNS = [
  /\/live\//i,
  /\/stream\//i,
  /\/hls\//i,
  /\/dash\//i,
  /\/media\//i,
  /\/video\//i,
  /\/audio\//i,
  /mux\.(?:m3u8|mpd|ts)/i,
  /webrtc/i,
  /mediasoup/i,
  /janus/i,
  /kurento/i,
  /livekit/i,
  /jitsi/i,
  /mediarecorder/i,
];

export class WebSocketWebRtcCapturePlugin implements CapturePlugin {
  id = 'websocket-webrtc';
  name = 'WebSocketWebRtcCapturePlugin';
  requiredPermissions: string[] = [];
  supportedBrowsers = ['chrome', 'edge', 'firefox'] as const;

  async isEnabled(context: CaptureContext): Promise<boolean> {
    const html = context.html ?? context.content?.html ?? '';
    return WS_MEDIA_PATTERNS.some((pattern) => pattern.test(html));
  }

  async capture(context: CaptureContext): Promise<Candidate[]> {
    const html = context.html ?? context.content?.html ?? '';
    const base = context.pageUrl ?? context.content?.baseUrl ?? context.content?.url;
    const now = context.now ?? new Date().toISOString();
    const candidates: Candidate[] = [];

    const wsUrls = this.extractWebSocketUrls(html);
    for (const url of wsUrls) {
      const candidate = this.buildCandidate(url, base, now);
      if (candidate) candidates.push(candidate);
    }

    const rtcUrls = this.extractWebRtcUrls(html, base);
    for (const url of rtcUrls) {
      const candidate = this.buildCandidate(url, base, now);
      if (candidate) candidates.push(candidate);
    }

    const mediaRecorderUrls = this.extractMediaRecorderUrls(html);
    for (const url of mediaRecorderUrls) {
      const candidate = this.buildCandidate(url, base, now);
      if (candidate) candidates.push(candidate);
    }

    return candidates;
  }

  private extractWebSocketUrls(html: string): string[] {
    const urls = new Set<string>();
    const wsPatterns = [
      /(?:ws|wss):\/\/[^"'`\s<>,;]+/gi,
      /['"`](?:ws|wss):\/\/[^"'`\s]+['"`]/gi,
      /WebSocket\(['"`]([^"'`]+)['"`]\)/gi,
      /new\s+WebSocket\s*\(\s*['"`]([^"'`]+)['"`]/gi,
    ];
    for (const pattern of wsPatterns) {
      for (const match of html.matchAll(pattern)) {
        const raw = match[1] ?? match[0] ?? '';
        const cleaned = raw.replace(/^['"`]|['"`]$/g, '');
        if (MEDIA_STREAM_EXTENSIONS.test(cleaned) || WS_MEDIA_PATTERNS.some((p) => p.test(cleaned))) {
          urls.add(cleaned);
        }
      }
    }
    return [...urls];
  }

  private extractWebRtcUrls(html: string, _base?: string): string[] {
    const urls: string[] = [];
    const rtcPatterns = [
      /RTCPeerConnection|RTCSessionDescription|createOffer|createAnswer/gi,
      /iceServers\s*:\s*\[([^\]]+)\]/gi,
      /urls?\s*:\s*['"`](stun:|turn:|turns:)[^'"`]+['"`]/gi,
      /mediasoup|simple-peer|peerjs|socket\.io\/webrtc/i,
    ];
    const hasRtc = rtcPatterns.some((p) => p.test(html));
    if (!hasRtc) return urls;

    const turnPattern = /['"`](?:turn|turns|stun):\/\/[^'"`]+['"`]/gi;
    for (const match of html.matchAll(turnPattern)) {
      urls.push(match[0].replace(/^['"`]|['"`]$/g, ''));
    }
    return urls;
  }

  private extractMediaRecorderUrls(html: string): string[] {
    const urls: string[] = [];
    const patterns = [
      /MediaRecorder\s*\(/gi,
      /mediaRecorder\.\s*ondataavailable/gi,
      /\.\s*addEventListener\s*\(\s*['"]dataavailable['"]/gi,
      /captureStream\s*\(\s*\)/gi,
      /getDisplayMedia\s*\(\s*\)/gi,
      /getUserMedia\s*\(\s*\{/gi,
    ];
    for (const pattern of patterns) {
      if (pattern.test(html)) {
        urls.push('page-media-stream');
        break;
      }
    }
    return urls;
  }

  private buildCandidate(url: string, base?: string, now?: string): Candidate | undefined {
    try {
      const absoluteUrl = url.startsWith('ws') || url.startsWith('http') ? url : base ? new URL(url, base).toString() : url;
      const mediaType = classifyByUrl(absoluteUrl);
      if (mediaType === 'other') return undefined;
      return {
        id: crypto.randomUUID(),
        url: absoluteUrl,
        pageUrl: base,
        source: 'websocket-webrtc',
        mediaType,
        extension: extensionOf(absoluteUrl),
        mimeType: url.startsWith('ws') ? 'application/x-websocket' : url.startsWith('turn') || url.startsWith('stun') ? 'application/x-rtc-ice' : undefined,
        confidence: 40,
        createdAt: now ?? new Date().toISOString(),
        metadata: {
          streamType: url.startsWith('ws') || url.startsWith('wss') ? 'websocket' : url.includes('turn') || url.includes('stun') ? 'webrtc-ice' : 'mediarecorder',
          assistiveSource: 'websocket-webrtc-detection',
        },
        evidence: [{
          source: 'websocket-webrtc',
          reason: `Potential media stream detected via ${url.startsWith('ws') || url.startsWith('wss') ? 'WebSocket' : url.includes('turn') || url.includes('stun') ? 'WebRTC/ICE' : 'MediaRecorder'}`,
          weight: 10,
          observedAt: Date.now(),
          details: { url: absoluteUrl },
        }],
      };
    } catch {
      return undefined;
    }
  }
}
