import { Candidate } from '../contracts/candidate.schema';
import { CaptureContext } from './capture-context';
import { CapturePlugin } from './capture-plugin';
import { extensionOf } from '../utils/url';

export class MediaElementProbePlugin implements CapturePlugin {
  id = 'media-element-probe';
  name = 'MediaElementProbePlugin';
  requiredPermissions: string[] = [];
  supportedBrowsers = ['chrome', 'edge', 'firefox'] as const;

  async isEnabled(context: CaptureContext): Promise<boolean> {
    return (context.content?.media.length ?? 0) > 0;
  }

  async capture(context: CaptureContext): Promise<Candidate[]> {
    const now = context.now ?? new Date().toISOString();
    return (context.content?.media ?? []).map((item): Candidate => ({
      id: crypto.randomUUID(),
      url: item.url,
      pageUrl: context.pageUrl ?? context.content?.url,
      source: 'media-element',
      mediaType: item.kind,
      extension: extensionOf(item.url),
      width: item.width,
      height: item.height,
      durationSec: item.durationSec,
      confidence: 0,
      createdAt: now,
      metadata: item.poster ? { poster: item.poster } : undefined,
    }));
  }
}
