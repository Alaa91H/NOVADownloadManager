import { Candidate, CandidateSchema } from '../contracts/candidate.schema';
import { MetadataEnricher } from '../pipeline/metadata-enricher';
import { dedupeCandidates } from '../pipeline/dedupe';
import { DomLinkCapturePlugin } from './dom-capture';
import { DownloadsCapturePlugin } from './downloads-capture';
import { EmbeddedMediaCapturePlugin } from './embedded-media-capture';
import { HlsManifestCapturePlugin } from './hls-capture';
import { DashManifestCapturePlugin } from './dash-capture';
import { MediaElementProbePlugin } from './media-element-probe';
import { NetworkHeaderCapturePlugin } from './network-capture';
import { OpenGraphJsonLdCapturePlugin } from './opengraph-jsonld-capture';
import { TorrentMagnetCapturePlugin } from './torrent-magnet-capture';
import { ContextMenuCapturePlugin } from './context-menu-capture';
import { WebSocketWebRtcCapturePlugin } from './websocket-webrtc-capture';
import { PlatformCapturePlugin } from '../platforms/platform-capture-plugin';
import { CaptureContext } from './capture-context';
import { CapturePlugin } from './capture-plugin';
import { RuleEngine } from '../rules/rule-engine';
import { SettingsStore } from '../storage/settings-store';
import { SiteRulesStore } from '../storage/site-rules-store';
import { filterNew } from '../content/incremental-scanner';

export type CapturePipelineOptions = {
  includeContextMenu?: boolean;
  bypassRules?: boolean;
  incremental?: boolean;
};

export class CandidatePipeline {
  private readonly enricher = new MetadataEnricher();
  private readonly settingsStore = new SettingsStore();
  private readonly siteRulesStore = new SiteRulesStore();

  private pluginsForSettings(settings: Awaited<ReturnType<SettingsStore['get']>>): CapturePlugin[] {
    const plugins: CapturePlugin[] = [];
    if (settings.capture.dom) plugins.push(new DomLinkCapturePlugin());
    if (settings.capture.dom) plugins.push(new EmbeddedMediaCapturePlugin());
    if (settings.capture.network || settings.capture.aggressiveMode) plugins.push(new NetworkHeaderCapturePlugin());
    if (settings.capture.downloads || settings.capture.aggressiveMode) plugins.push(new DownloadsCapturePlugin());
    if (settings.capture.hlsDash) plugins.push(new HlsManifestCapturePlugin(), new DashManifestCapturePlugin());
    if (settings.capture.mediaProbe) plugins.push(new MediaElementProbePlugin());
    if (settings.capture.network || settings.capture.aggressiveMode) plugins.push(new WebSocketWebRtcCapturePlugin());
    plugins.push(new OpenGraphJsonLdCapturePlugin(), new TorrentMagnetCapturePlugin());
    plugins.push(new PlatformCapturePlugin());
    return plugins;
  }

  async run(context: CaptureContext, options: CapturePipelineOptions = {}): Promise<Candidate[]> {
    const settings = await this.settingsStore.get();
    if (!settings.enabled) return [];

    const basePlugins = this.pluginsForSettings(settings);
    const plugins = options.includeContextMenu ? [new ContextMenuCapturePlugin(), ...basePlugins] : basePlugins;
    const captured: Candidate[] = [];

    for (const plugin of plugins) {
      if (!(await plugin.isEnabled(context))) continue;
      const result = await plugin.capture(context);
      for (const candidate of result) {
        const parsed = CandidateSchema.safeParse(candidate);
        if (parsed.success) captured.push(parsed.data);
      }
    }

    let fresh = captured;
    if (options.incremental) fresh = filterNew(captured);

    const enriched = dedupeCandidates(fresh.map((candidate) => this.enricher.enrich(candidate)));
    if (options.bypassRules) return enriched;

    const rules = await this.siteRulesStore.list();
    const engine = new RuleEngine(rules);
    const minimumBytes = settings.capture.minFileSizeMB * 1024 * 1024;
    return enriched.filter((candidate) => {
      if (!settings.capture.aggressiveMode && !settings.capture.showLowConfidence && candidate.confidence < 20) return false;
      if (!settings.capture.aggressiveMode && (candidate.sizeBytes ?? minimumBytes) < minimumBytes && !['magnet', 'torrent', 'manifest'].includes(candidate.mediaType)) return false;
      return engine.shouldShow(candidate);
    });
  }
}
