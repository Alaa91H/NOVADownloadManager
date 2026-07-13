import { contextMenuEvidence } from '../pipeline/evidence';
import { Candidate } from '../contracts/candidate.schema';
import { classifyByUrl } from '../pipeline/mime-detector';
import { extensionOf } from '../utils/url';
import { CaptureContext } from './capture-context';
import { CapturePlugin } from './capture-plugin';

export class ContextMenuCapturePlugin implements CapturePlugin {
  id = 'context-menu-capture';
  name = 'ContextMenuCapturePlugin';
  requiredPermissions: string[] = [];
  supportedBrowsers = ['chrome', 'edge', 'firefox'] as const;

  async isEnabled(context: CaptureContext): Promise<boolean> {
    return Boolean(context.linkUrl || context.srcUrl || context.selectionText);
  }

  async capture(context: CaptureContext): Promise<Candidate[]> {
    const now = context.now ?? new Date().toISOString();
    const urls = new Set<string>();
    if (context.linkUrl) urls.add(context.linkUrl);
    if (context.srcUrl) urls.add(context.srcUrl);
    for (const match of (context.selectionText ?? '').matchAll(/(magnet:\?xt=urn:btih:[^\s]+|https?:\/\/[^\s"'<>]+)/gi)) {
      urls.add(match[1] ?? '');
    }
    return [...urls].filter(Boolean).map((url): Candidate => ({
      id: crypto.randomUUID(),
      url,
      pageUrl: context.pageUrl,
      referrer: context.pageUrl,
      source: 'context-menu',
      mediaType: classifyByUrl(url),
      extension: extensionOf(url),
      confidence: 0,
      createdAt: now,
      evidence: [contextMenuEvidence()],
    }));
  }
}
