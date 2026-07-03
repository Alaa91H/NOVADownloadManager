import { Candidate } from '../contracts/candidate.schema';
import { classifyByUrl } from '../pipeline/mime-detector';
import { extensionOf } from '../utils/url';
import { CaptureContext } from './capture-context';
import { CapturePlugin } from './capture-plugin';
import { openGraphEvidence } from '../pipeline/evidence';

const OG_RE = /<meta\s+[^>]*(?:property|name)=['"]og:(video|audio|image)(?::url)?['"][^>]*content=['"]([^'"]+)['"][^>]*>/gi;
const JSONLD_RE = /<script\s+[^>]*type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi;

function absolute(raw: string, base?: string): string | undefined {
  try { return new URL(raw, base).toString(); } catch { return undefined; }
}

function collectJsonLdUrls(value: unknown, urls: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdUrls(item, urls);
    return;
  }
  const obj = value as Record<string, unknown>;
  const type = obj['@type'];
  const relevant = type === 'VideoObject' || type === 'AudioObject' || type === 'ImageObject' || (Array.isArray(type) && type.some((t) => t === 'VideoObject' || t === 'AudioObject' || t === 'ImageObject'));
  if (relevant) {
    for (const key of ['contentUrl', 'embedUrl', 'thumbnailUrl', 'url']) {
      const v = obj[key];
      if (typeof v === 'string') urls.add(v);
      if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') urls.add(x);
    }
  }
  for (const nested of Object.values(obj)) collectJsonLdUrls(nested, urls);
}

export class OpenGraphJsonLdCapturePlugin implements CapturePlugin {
  id = 'opengraph-jsonld-capture';
  name = 'OpenGraphJsonLdCapturePlugin';
  requiredPermissions: string[] = [];
  supportedBrowsers = ['chrome', 'edge', 'firefox'] as const;

  async isEnabled(context: CaptureContext): Promise<boolean> {
    return Boolean((context.content?.openGraph.length ?? 0) > 0 || (context.content?.jsonLd.length ?? 0) > 0 || (context.html ?? context.content?.html));
  }

  async capture(context: CaptureContext): Promise<Candidate[]> {
    const html = context.html ?? context.content?.html ?? '';
    const base = context.pageUrl ?? context.content?.baseUrl ?? context.content?.url;
    const now = context.now ?? new Date().toISOString();
    const urls = new Set<string>();

    for (const link of context.content?.openGraph ?? []) {
      const url = absolute(link.url, base);
      if (url) urls.add(url);
    }
    for (const item of context.content?.jsonLd ?? []) collectJsonLdUrls(item, urls);

    for (const match of html.matchAll(OG_RE)) {
      const url = absolute(match[2] ?? '', base);
      if (url) urls.add(url);
    }
    for (const match of html.matchAll(JSONLD_RE)) {
      try { collectJsonLdUrls(JSON.parse(match[1] ?? '{}'), urls); } catch { /* ignored */ }
    }
    return [...urls].map((raw): Candidate | undefined => {
      const url = absolute(raw, base);
      if (!url) return undefined;
      return {
        id: crypto.randomUUID(),
        url,
        pageUrl: base,
        source: 'opengraph',
        mediaType: classifyByUrl(url),
        extension: extensionOf(url),
        confidence: 0,
        createdAt: now,
        metadata: { assistiveSource: 'opengraph-jsonld' },
        evidence: [openGraphEvidence('opengraph-jsonld')],
      };
    }).filter((candidate): candidate is Candidate => Boolean(candidate));
  }
}
