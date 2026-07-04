import { Candidate } from '../contracts/candidate.schema';
import { extensionOf } from '../utils/url';

type MediaType = Candidate['mediaType'];

const extMap: Record<string, MediaType> = {
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', bz2: 'archive', xz: 'archive', zst: 'archive', cab: 'archive',
  exe: 'app', msi: 'app', dmg: 'app', pkg: 'app', appimage: 'app', deb: 'app', rpm: 'app', iso: 'app', img: 'app', crx: 'app',
  pdf: 'document', epub: 'document', mobi: 'document', doc: 'document', docx: 'document', xls: 'document', xlsx: 'document', ppt: 'document', pptx: 'document', csv: 'document', txt: 'document',
  mp4: 'video', mkv: 'video', webm: 'video', avi: 'video', mov: 'video', m4v: 'video', flv: 'video', mpeg: 'video', mpg: 'video', '3gp': 'video', '3g2': 'video', ogv: 'video', ts: 'video', m2ts: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', ogg: 'audio', opus: 'audio', aac: 'audio', wma: 'audio', aiff: 'audio', aif: 'audio',
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', svg: 'image', avif: 'image',
  apk: 'app', xapk: 'app', m3u8: 'manifest', m3u: 'manifest', mpd: 'manifest', torrent: 'torrent', magnet: 'magnet',
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
