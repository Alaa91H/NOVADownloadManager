import { Candidate } from '../contracts/candidate.schema';
import { ContentLinkSnapshot } from '../contracts/messages.schema';
import { classifyByUrl } from '../pipeline/mime-detector';
import { extensionOf, safeAbsoluteUrl } from '../utils/url';
import { CaptureContext } from './capture-context';
import { domLinkEvidence } from '../pipeline/evidence';
import { CapturePlugin } from './capture-plugin';

const ATTR_RE = /\b(?:href|src|data-src|data-href|data-file|data-media|data-video|data-stream|poster|data-url|data-download)=['"]([^'"]+)['"]/gi;
const DOWNLOAD_ATTR_RE = /<a\b[^>]*\bdownload(?:=['"]?([^'"\s>]+)['"]?)?[^>]*\bhref=['"]([^'"]+)['"][^>]*>/gi;

function sourceConfidenceHints(link: ContentLinkSnapshot): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (link.download !== undefined) metadata.downloadAttribute = true;
  if (link.rel) metadata.rel = link.rel;
  if (link.type) metadata.linkType = link.type;
  if (link.attr) metadata.attribute = link.attr;
  if (link.tag) metadata.tag = link.tag;
  return Object.keys(metadata).length ? metadata : undefined;
}

export class DomLinkCapturePlugin implements CapturePlugin {
  id = 'dom';
  name = 'DOM link capture';
  requiredPermissions: string[] = [];
  supportedBrowsers = ['chrome', 'edge', 'firefox'] as const;

  async isEnabled(context: CaptureContext): Promise<boolean> {
    return Boolean((context.content?.links.length ?? 0) > 0 || (context.html ?? context.content?.html));
  }

  async capture(ctx: CaptureContext): Promise<Candidate[]> {
    const now = ctx.now ?? new Date().toISOString();
    const base = ctx.pageUrl ?? ctx.content?.baseUrl ?? ctx.content?.url;
    const candidates: Candidate[] = [];

    for (const link of ctx.content?.links ?? []) {
      const url = safeAbsoluteUrl(link.url, base);
      if (!url) continue;
      candidates.push({
        id: crypto.randomUUID(),
        url,
        pageUrl: ctx.pageUrl ?? ctx.content?.url,
        source: 'dom',
        mediaType: classifyByUrl(url),
        mimeType: link.type?.includes('/') ? link.type : undefined,
        extension: extensionOf(url),
        filename: link.download || undefined,
        width: link.width,
        height: link.height,
        confidence: 0,
        createdAt: now,
        metadata: sourceConfidenceHints(link),
        evidence: [domLinkEvidence({ tag: link.tag, attr: link.attr, hasDownload: Boolean(link.download) })],
      });
    }

    const html = ctx.html ?? ctx.content?.html;
    if (!html) return candidates;

    for (const match of html.matchAll(ATTR_RE)) {
      const url = safeAbsoluteUrl(match[1] ?? '', base);
      if (!url) continue;
      candidates.push({
        id: crypto.randomUUID(),
        url,
        pageUrl: ctx.pageUrl ?? ctx.content?.url,
        source: 'dom',
        mediaType: classifyByUrl(url),
        extension: extensionOf(url),
        confidence: 0,
        createdAt: now,
        evidence: [domLinkEvidence({ via: 'html-attr-regex' })],
      });
    }
    for (const match of html.matchAll(DOWNLOAD_ATTR_RE)) {
      const url = safeAbsoluteUrl(match[2] ?? '', base);
      if (!url) continue;
      candidates.push({
        id: crypto.randomUUID(),
        url,
        pageUrl: ctx.pageUrl ?? ctx.content?.url,
        source: 'dom',
        mediaType: classifyByUrl(url),
        extension: extensionOf(url),
        filename: match[1] || undefined,
        confidence: 0,
        createdAt: now,
        metadata: { downloadAttribute: true },
        evidence: [domLinkEvidence({ via: 'download-attr', filename: match[1] || undefined })],
      });
    }
    return candidates;
  }
}
