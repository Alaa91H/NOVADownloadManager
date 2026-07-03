import { Candidate } from '../contracts/candidate.schema';
import { extensionOf } from '../utils/url';
import { CaptureContext } from './capture-context';
import { CapturePlugin } from './capture-plugin';

const TORRENT_RE = /(magnet:\?xt=urn:btih:[^"'\s<]+|https?:\/\/[^"'\s<]+\.torrent(?:\?[^"'\s<]*)?)/gi;

export class TorrentMagnetCapturePlugin implements CapturePlugin {
  id = 'torrent-magnet';
  name = 'Torrent and magnet capture';
  requiredPermissions: string[] = [];
  supportedBrowsers = ['chrome', 'edge', 'firefox'] as const;

  async isEnabled(): Promise<boolean> {
    return true;
  }

  async capture(ctx: CaptureContext): Promise<Candidate[]> {
    const html = ctx.html ?? ctx.content?.html ?? '';
    const now = ctx.now ?? new Date().toISOString();
    const out: Candidate[] = [];
    for (const match of html.matchAll(TORRENT_RE)) {
      const raw = match[1] ?? '';
      const isMagnet = raw.startsWith('magnet:');
      const url = isMagnet ? raw : new URL(raw, ctx.pageUrl ?? ctx.content?.url).toString();
      out.push({
        id: crypto.randomUUID(),
        url,
        pageUrl: ctx.pageUrl ?? ctx.content?.url,
        source: 'dom',
        mediaType: isMagnet ? 'magnet' : 'torrent',
        extension: isMagnet ? undefined : extensionOf(url),
        confidence: 0,
        createdAt: now,
      });
    }
    return out;
  }
}
