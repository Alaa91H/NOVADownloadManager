import { Candidate } from '../contracts/candidate.schema';
import { filenameFromContentDisposition, filenameFromUrl } from './filename-extractor';
import { sizeFromHeaders } from './size-detector';
import { classifyCandidate } from './classifier';
import { normalizeCandidate } from './normalizer';
import { CandidateScorer } from './scorer';

const VIDEO_CODEC_PATTERNS: Array<{ re: RegExp; codec: string }> = [
  { re: /avc1/i, codec: 'H.264' },
  { re: /hvc1|hev1/i, codec: 'H.265' },
  { re: /vp09|vp9/i, codec: 'VP9' },
  { re: /vp8/i, codec: 'VP8' },
  { re: /av01|av1/i, codec: 'AV1' },
  { re: /theora/i, codec: 'Theora' },
];

const AUDIO_CODEC_PATTERNS: Array<{ re: RegExp; codec: string }> = [
  { re: /mp4a|mp4a\.40/i, codec: 'AAC' },
  { re: /opus/i, codec: 'Opus' },
  { re: /vorbis/i, codec: 'Vorbis' },
  { re: /flac/i, codec: 'FLAC' },
  { re: /mp3|mpeg.*layer\s*3/i, codec: 'MP3' },
  { re: /ac-3|ac3/i, codec: 'Dolby Digital' },
  { re: /eac-3|eac3/i, codec: 'Dolby Digital Plus' },
  { re: /dts/i, codec: 'DTS' },
];

function detectCodecsFromMime(mime?: string): string[] {
  if (!mime) return [];
  const codecs: string[] = [];
  for (const { re, codec } of VIDEO_CODEC_PATTERNS) {
    if (re.test(mime)) codecs.push(codec);
  }
  for (const { re, codec } of AUDIO_CODEC_PATTERNS) {
    if (re.test(mime)) codecs.push(codec);
  }
  return [...new Set(codecs)];
}

function detectCodecsFromUrl(url?: string): string[] {
  if (!url) return [];
  const codecs: string[] = [];
  const lower = url.toLowerCase();
  if (lower.includes('avc1') || lower.includes('h264') || lower.includes('avc.')) codecs.push('H.264');
  if (lower.includes('hvc1') || lower.includes('hev1') || lower.includes('h265')) codecs.push('H.265');
  if (lower.includes('vp09') || lower.includes('vp9')) codecs.push('VP9');
  if (lower.includes('av01') || lower.includes('av1')) codecs.push('AV1');
  if (lower.includes('mp4a') || lower.includes('aac')) codecs.push('AAC');
  if (lower.includes('opus')) codecs.push('Opus');
  return [...new Set(codecs)];
}

function detectContainerFromMime(mime?: string): string | undefined {
  if (!mime) return undefined;
  const m = mime.toLowerCase();
  if (m.includes('mpegurl') || m === 'application/x-mpegurl' || m === 'application/vnd.apple.mpegurl') return 'm3u8';
  if (m.includes('dash+xml') || m === 'application/dash+xml') return 'mpd';
  if (m === 'video/mp4' || m === 'audio/mp4' || m === 'video/x-m4v' || m === 'audio/x-m4a') return 'mp4';
  if (m === 'video/webm' || m === 'audio/webm') return 'webm';
  if (m === 'video/x-matroska') return 'mkv';
  if (m === 'video/quicktime') return 'mov';
  if (m === 'video/x-msvideo') return 'avi';
  if (m === 'video/x-flv') return 'flv';
  if (m === 'video/x-ms-wmv') return 'wmv';
  if (m === 'video/mpeg') return 'mpeg';
  if (m === 'video/3gpp') return '3gp';
  if (m === 'video/ogg' || m === 'video/ogv') return 'ogv';
  if (m === 'audio/mpeg' || m === 'audio/mp3') return 'mp3';
  if (m === 'audio/wav') return 'wav';
  if (m === 'audio/flac') return 'flac';
  if (m === 'audio/ogg') return 'ogg';
  if (m === 'audio/aac') return 'aac';
  return undefined;
}

function estimateDurationFromUrl(url?: string): number | undefined {
  if (!url) return undefined;
  const durationMatch = url.match(/(?:duration|dur|length|d)[=:]([0-9]+(?:\.[0-9]+)?)/i);
  if (durationMatch && durationMatch[1]) {
    const val = parseFloat(durationMatch[1]);
    if (Number.isFinite(val) && val > 0 && val < 86400) return val;
  }
  const timeMatch = url.match(/(?:start|end|t)[=:](\d+)/i);
  return undefined;
}

export class MetadataEnricher {
  private scorer = new CandidateScorer();

  enrich(candidate: Candidate): Candidate {
    let next = normalizeCandidate(candidate);

    const filename = next.filename ?? filenameFromContentDisposition(next.headers?.contentDisposition) ?? filenameFromUrl(next.finalUrl ?? next.url);
    const mimeType = next.mimeType ?? next.headers?.contentType;
    const sizeBytes = next.sizeBytes ?? sizeFromHeaders(next.headers);
    const codecs = next.codecs?.length ? next.codecs : [
      ...detectCodecsFromMime(mimeType),
      ...detectCodecsFromUrl(next.finalUrl ?? next.url),
    ];

    const urlContainer = detectContainerFromMime(mimeType);
    const extension = next.extension ?? urlContainer;

    const durationFromUrl = estimateDurationFromUrl(next.finalUrl ?? next.url);
    const durationSec = next.durationSec ?? durationFromUrl;

    next = {
      ...next,
      filename,
      mimeType,
      sizeBytes,
      codecs: codecs.length > 0 ? codecs : undefined,
      extension: next.extension ?? extension,
      durationSec,
    };

    next = classifyCandidate(next);

    if (!next.sizeBytes && next.bitrate && next.durationSec) {
      next = { ...next, sizeBytes: Math.round((next.bitrate * next.durationSec) / 8) };
    }

    return { ...next, confidence: this.scorer.score(next), updatedAt: new Date().toISOString() };
  }
}
