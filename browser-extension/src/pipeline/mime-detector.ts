import { Candidate } from '../contracts/candidate.schema';
import { extensionOf } from '../utils/url';

type MediaType = Candidate['mediaType'];

const extMap: Record<string, MediaType> = {
  // Video
  mp4: 'video', m4v: 'video', webm: 'video', mkv: 'video', mov: 'video', avi: 'video',
  flv: 'video', wmv: 'video', vob: 'video', ogv: 'video', ogm: 'video',
  '3gp': 'video', '3g2': 'video', ts: 'video', m2ts: 'video', mts: 'video',
  mpeg: 'video', mpg: 'video', divx: 'video', f4v: 'video', rm: 'video', rmvb: 'video',
  asf: 'video', m4p: 'video',
  // Audio
  mp3: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', wav: 'audio',
  ogg: 'audio', opus: 'audio', wma: 'audio', aiff: 'audio', aif: 'audio',
  ape: 'audio', alac: 'audio', mid: 'audio', midi: 'audio',
  // Image
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image',
  svg: 'image', avif: 'image', heic: 'image', heif: 'image', bmp: 'image',
  tiff: 'image', tif: 'image', ico: 'image', raw: 'image', cr2: 'image',
  nef: 'image', arw: 'image',
  // Manifest
  m3u8: 'manifest', m3u: 'manifest', mpd: 'manifest',
  // Archive
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
  bz2: 'archive', xz: 'archive', zst: 'archive', cab: 'archive', dmg: 'archive',
  // App
  exe: 'app', msi: 'app', pkg: 'app', appimage: 'app', deb: 'app', rpm: 'app',
  iso: 'app', img: 'app', crx: 'app', apk: 'app', xapk: 'app', app: 'app', msix: 'app',
  // Document
  pdf: 'document', epub: 'document', mobi: 'document', doc: 'document', docx: 'document',
  xls: 'document', xlsx: 'document', ppt: 'document', pptx: 'document',
  csv: 'document', txt: 'document', rtf: 'document', odt: 'document', ods: 'document', odp: 'document',
  // Torrent
  torrent: 'torrent', magnet: 'magnet',
  // Subtitle
  srt: 'other', ass: 'other', ssa: 'other', vtt: 'other', sub: 'other', idx: 'other',
};

export function classifyByUrl(url: string): MediaType {
  if (url.startsWith('magnet:?xt=urn:btih')) return 'magnet';
  const ext = extensionOf(url);
  return ext ? extMap[ext] ?? 'other' : 'other';
}

export function mediaTypeFromMime(mime?: string): MediaType | undefined {
  if (!mime) return undefined;
  const normalized = mime.toLowerCase();
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.includes('mpegurl') || normalized.includes('dash+xml')) return 'manifest';
  if (normalized.includes('bittorrent')) return 'torrent';
  if (/(zip|x-rar|7z|tar|gzip|bzip2|xz|zstd|archive)/.test(normalized)) return 'archive';
  if (/(msdownload|x-msi|x-apple-diskimage|android\.package-archive|x-debian-package|x-rpm|x-iso9660-image)/.test(normalized)) return 'app';
  if (/(pdf|epub|msword|officedocument|spreadsheet|presentation|text\/csv|text\/plain)/.test(normalized)) return 'document';
  return undefined;
}
