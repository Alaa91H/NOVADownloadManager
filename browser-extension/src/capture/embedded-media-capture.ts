import { Candidate } from '../contracts/candidate.schema';
import { classifyByUrl } from '../pipeline/mime-detector';
import { extensionOf, safeAbsoluteUrl } from '../utils/url';
import { CaptureContext } from './capture-context';
import { CapturePlugin } from './capture-plugin';

const EMBEDDED_MEDIA_EXTENSIONS = [
  'm3u8',
  'mpd',
  'mp4',
  'm4v',
  'webm',
  'mkv',
  'mov',
  'avi',
  'flv',
  'mp3',
  'm4a',
  'aac',
  'flac',
  'wav',
  'ogg',
  'opus',
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'zst',
  'cab',
  'exe',
  'msi',
  'dmg',
  'pkg',
  'appimage',
  'deb',
  'rpm',
  'iso',
  'img',
  'crx',
  'apk',
  'xapk',
  'pdf',
  'epub',
  'mobi',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'csv',
  'txt',
  'torrent',
  'm3u',
  'mpeg',
  'mpg',
  '3gp',
  '3g2',
  'ogv',
  'ts',
  'm2ts',
  'wma',
  'aiff',
  'aif',
];

const EMBEDDED_MEDIA_EXTENSION_PATTERN = EMBEDDED_MEDIA_EXTENSIONS.join('|');
const ABSOLUTE_EMBEDDED_MEDIA_RE = new RegExp(
  String.raw`(?:https?:)?(?:\\?\/){2}[^"'<>\s]+?\.(${EMBEDDED_MEDIA_EXTENSION_PATTERN})(?:[?#][^"'<>\s]*)?`,
  'gi',
);
const RELATIVE_EMBEDDED_MEDIA_RE = new RegExp(
  String.raw`(?:[:=,\[(]\s*["']?)((?:\.{0,2}\\?\/|\/)[^"'<>\s]+?\.(${EMBEDDED_MEDIA_EXTENSION_PATTERN})(?:[?#][^"'<>\s]*)?)`,
  'gi',
);

function cleanEmbeddedUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/[\])},;]+$/g, '');
}

function safeEmbeddedUrl(raw: string, base?: string): string | undefined {
  const cleaned = cleanEmbeddedUrl(raw);
  return safeAbsoluteUrl(cleaned, base);
}

export function collectEmbeddedMediaUrls(text: string, base?: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(ABSOLUTE_EMBEDDED_MEDIA_RE)) {
    const url = safeEmbeddedUrl(match[0] ?? '', base);
    if (url) urls.add(url);
  }
  for (const match of text.matchAll(RELATIVE_EMBEDDED_MEDIA_RE)) {
    const url = safeEmbeddedUrl(match[1] ?? '', base);
    if (url) urls.add(url);
  }
  return [...urls];
}

export class EmbeddedMediaCapturePlugin implements CapturePlugin {
  id = 'embedded-media';
  name = 'EmbeddedMediaCapturePlugin';
  requiredPermissions: string[] = [];
  supportedBrowsers = ['chrome', 'edge', 'firefox'] as const;

  async isEnabled(context: CaptureContext): Promise<boolean> {
    return Boolean(context.html ?? context.content?.html);
  }

  async capture(context: CaptureContext): Promise<Candidate[]> {
    const html = context.html ?? context.content?.html ?? '';
    const base = context.pageUrl ?? context.content?.baseUrl ?? context.content?.url;
    const now = context.now ?? new Date().toISOString();
    return collectEmbeddedMediaUrls(html, base).map((url): Candidate => ({
      id: crypto.randomUUID(),
      url,
      pageUrl: context.pageUrl ?? context.content?.url,
      source: 'dom',
      mediaType: classifyByUrl(url),
      extension: extensionOf(url),
      confidence: 0,
      createdAt: now,
      metadata: { assistiveSource: 'embedded-media' },
    }));
  }
}
