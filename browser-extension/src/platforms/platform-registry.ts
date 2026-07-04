import { PlatformAdapter } from './base-platform-adapter';
import type { ContentScanResponse } from '../contracts/messages.schema';
import { YoutubeAdapter } from './youtube-adapter';
import { InstagramAdapter } from './instagram-adapter';
import { TwitterAdapter } from './twitter-adapter';
import { TikTokAdapter } from './tiktok-adapter';
import { FacebookAdapter } from './facebook-adapter';
import { RedditAdapter } from './reddit-adapter';
import { TwitchAdapter } from './twitch-adapter';
import { VimeoAdapter } from './vimeo-adapter';
import { DailymotionAdapter } from './dailymotion-adapter';
import { SoundCloudAdapter } from './soundcloud-adapter';
import { LinkedInAdapter } from './linkedin-adapter';
import { PinterestAdapter } from './pinterest-adapter';
import { DiscordAdapter } from './discord-adapter';
import { TelegramAdapter } from './telegram-adapter';
import { WhatsAppAdapter } from './whatsapp-adapter';
import { VkAdapter } from './vk-adapter';
import { BilibiliAdapter } from './bilibili-adapter';
import { TumblrAdapter } from './tumblr-adapter';
import { RumbleAdapter } from './rumble-adapter';
import { OdyseeAdapter } from './odysee-adapter';
import { JwPlayerAdapter } from './jwplayer-adapter';
import { KalturaAdapter } from './kaltura-adapter';
import { WistiaAdapter } from './wistia-adapter';
import { BrightcoveAdapter } from './brightcove-adapter';

class PlatformRegistry {
  private readonly adapters = new Map<string, PlatformAdapter>();
  private readonly hostMap = new Map<string, PlatformAdapter>();

  register(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.id, adapter);
    for (const host of adapter.hosts) {
      this.hostMap.set(host, adapter);
    }
  }

  get(id: string): PlatformAdapter | undefined {
    return this.adapters.get(id);
  }

  forHost(hostname: string): PlatformAdapter | undefined {
    const direct = this.hostMap.get(hostname);
    if (direct) return direct;
    for (const [host, adapter] of this.hostMap) {
      if (host.startsWith('*.')) {
        const suffix = host.slice(1);
        if (hostname.endsWith(suffix)) return adapter;
      }
    }
    return undefined;
  }

  forURL(url: string): PlatformAdapter | undefined {
    try {
      return this.forHost(new URL(url).hostname.toLowerCase());
    } catch { return undefined; }
  }

  forCDN(url: string): PlatformAdapter | undefined {
    try {
      for (const adapter of this.adapters.values()) {
        if (adapter.matchesCDN(url)) return adapter;
      }
    } catch { /* ignore */ }
    return undefined;
  }

  all(): PlatformAdapter[] {
    return [...this.adapters.values()];
  }

  /** Extract platform-specific data from a content scan, in host order */
  extractFromScan(url: string, content: ContentScanResponse) {
    const adapter = this.forURL(url);
    if (!adapter) return [];
    return adapter.extractFromScan(content);
  }
}

export const platformRegistry = new PlatformRegistry();

function init(): void {
  const adapters = [
    new YoutubeAdapter(),
    new InstagramAdapter(),
    new TwitterAdapter(),
    new TikTokAdapter(),
    new FacebookAdapter(),
    new RedditAdapter(),
    new TwitchAdapter(),
    new VimeoAdapter(),
    new DailymotionAdapter(),
    new SoundCloudAdapter(),
    new LinkedInAdapter(),
    new PinterestAdapter(),
    new DiscordAdapter(),
    new TelegramAdapter(),
    new WhatsAppAdapter(),
    new VkAdapter(),
    new BilibiliAdapter(),
    new TumblrAdapter(),
    new RumbleAdapter(),
    new OdyseeAdapter(),
    new JwPlayerAdapter(),
    new KalturaAdapter(),
    new WistiaAdapter(),
    new BrightcoveAdapter(),
  ];
  for (const a of adapters) platformRegistry.register(a);
}
init();
