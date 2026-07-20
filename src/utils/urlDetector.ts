export type UrlType = 'media' | 'download' | 'unknown';

const MEDIA_PATTERNS: { host: RegExp; path?: RegExp }[] = [
  // ═══════════════════════════════════════════════════
  //  YouTube (official)
  // ═══════════════════════════════════════════════════
  { host: /youtube\.com$/i, path: /\/watch\?v=|\/shorts\/|\/live\/|\/embed\/|\/playlist\?list=|\/v\// },
  { host: /youtu\.be$/i, path: /\/.+/ },
  { host: /music\.youtube\.com$/i },
  { host: /tv\.youtube\.com$/i },

  // ═══════════════════════════════════════════════════
  //  YouTube alternative frontends / mirrors
  // ═══════════════════════════════════════════════════
  { host: /invidious\..+$/i, path: /\/watch|\/shorts\/|\/playlist|\/embed\// },
  { host: /inv\.tux\.pizza$/i },
  { host: /vid\.puffyan\.us$/i },
  { host: /yewtu\.be$/i },
  { host: /inv\.nadeko\.net$/i },
  { host: /invidious\.fdn\.fr$/i },
  { host: /yt\.artemislena\.eu$/i },
  { host: /invidious\.private\.docker$/i },
  { host: /inv\.n8pjl\.ca$/i },
  { host: /invidious\.perennialte\.ch$/i },
  { host: /invidious\.snopyta\.org$/i },
  { host: /invidious\.kavin\.rocks$/i },
  { host: /inv\.in.projectsegfau\.lt$/i },
  { host: /invidious\.lovinotone\.com$/i },
  { host: /invidious\.lunar\.icu$/i },
  { host: /iv\.datura\.network$/i },

  { host: /piped\..+$/i, path: /\/watch|\/shorts\/|\/playlist|\/stream/ },
  { host: /piped\.video$/i },
  { host: /piped\.kavin\.rocks$/i },
  { host: /piped-api\..+$/i },
  { host: /watch\.whatever\.social$/i },
  { host: /piped\.adminforge\.de$/i },
  { host: /piped\.leptons\.xyz$/i },
  { host: /piped\.r4fo\.com$/i },
  { host: /piped\.projectsegfau\.lt$/i },
  { host: /piped\.privacytools\.io$/i },
  { host: /piped\.syncpundit\.io$/i },
  { host: /piped\.ngn\.tf$/i },
  { host: /piped\.hostux\.net$/i },
  { host: /piped\.slo\.video$/i },
  { host: /piped\.drgnspace\.ml$/i },

  { host: /cloudtube\.kavin\.rocks$/i },
  { host: /viewtube\..+$/i },
  { host: /ytb\.trom\.tf$/i },

  // ═══════════════════════════════════════════════════
  //  Vimeo
  // ═══════════════════════════════════════════════════
  { host: /vimeo\.com$/i, path: /\/\d+/ },
  { host: /player\.vimeo\.com$/i, path: /\/video\/\d+/ },

  // ═══════════════════════════════════════════════════
  //  TikTok
  // ═══════════════════════════════════════════════════
  { host: /tiktok\.com$/i, path: /\/@.+\/video\// },
  { host: /vm\.tiktok\.com$/i },
  { host: /vt\.tiktok\.com$/i },
  { host: /tiktok\.com$/i, path: /\/video\// },

  // ═══════════════════════════════════════════════════
  //  Instagram
  // ═══════════════════════════════════════════════════
  { host: /instagram\.com$/i, path: /\/(?:p|reel|tv|stories\/[^/]+\/|explore\/reels\/)\// },

  // ═══════════════════════════════════════════════════
  //  Twitter / X (official + mirrors)
  // ═══════════════════════════════════════════════════
  { host: /twitter\.com$/i, path: /\/\w+\/status\// },
  { host: /x\.com$/i, path: /\/\w+\/status\// },
  { host: /nitter\..+$/i, path: /\/\w+\/status\// },
  { host: /nitter\.poast\.org$/i },
  { host: /xcancel\.com$/i },
  { host: /twiiit\.com$/i },
  { host: /nitter\.privacydev\.net$/i },
  { host: /nitter\.woodland\.cafe$/i },
  { host: /nitter\.1d4\.us$/i },
  { host: /nitter\.eientei\.org$/i },
  { host: /bird\.frii\.se$/i },

  // ═══════════════════════════════════════════════════
  //  Facebook
  // ═══════════════════════════════════════════════════
  { host: /facebook\.com$/i, path: /\/(?:watch|reel|reels|share\/v|videos|reel\/video)\// },
  { host: /fb\.watch$/i },
  { host: /fbcdn\.net$/i, path: /\/v\// },

  // ═══════════════════════════════════════════════════
  //  Reddit (official + alternative frontends)
  // ═══════════════════════════════════════════════════
  { host: /reddit\.com$/i, path: /\/r\/\w+\/comments\// },
  { host: /old\.reddit\.com$/i, path: /\/r\/\w+\/comments\// },
  { host: /v\.redd\.it$/i },
  { host: /redlib\..+$/i },
  { host: /teddit\..+$/i },
  { host: /libreddit\..+$/i },

  // ═══════════════════════════════════════════════════
  //  SoundCloud
  // ═══════════════════════════════════════════════════
  { host: /soundcloud\.com$/i, path: /\/.+/ },
  { host: /on\.soundcloud\.com$/i },

  // ═══════════════════════════════════════════════════
  //  Dailymotion
  // ═══════════════════════════════════════════════════
  { host: /dailymotion\.com$/i, path: /\/video\// },
  { host: /dai\.ly$/i },

  // ═══════════════════════════════════════════════════
  //  Bilibili
  // ═══════════════════════════════════════════════════
  { host: /bilibili\.com$/i, path: /\/video\// },
  { host: /bilibili\.tv$/i, path: /\/video\// },
  { host: /b23\.tv$/i },

  // ═══════════════════════════════════════════════════
  //  Twitch
  // ═══════════════════════════════════════════════════
  { host: /twitch\.tv$/i, path: /\/\w+\/clip|\/videos\// },
  { host: /clips\.twitch\.tv$/i },

  // ═══════════════════════════════════════════════════
  //  Rumble
  // ═══════════════════════════════════════════════════
  { host: /rumble\.com$/i, path: /\/embed\/|\/v\// },
  { host: /rumble\.com$/i, path: /\/c\// },

  // ═══════════════════════════════════════════════════
  //  Odysee / LBRY
  // ═══════════════════════════════════════════════════
  { host: /odysee\.com$/i, path: /\/@.+\/.+/ },
  { host: /odysee\.com$/i, path: /\/.+/ },
  { host: /lbry\.tv$/i },
  { host: /lbry\.com$/i, path: /\/.+/ },
  { host: /odysee\.com$/i },

  // ═══════════════════════════════════════════════════
  //  BitChute
  // ═══════════════════════════════════════════════════
  { host: /bitchute\.com$/i, path: /\/video\// },

  // ═══════════════════════════════════════════════════
  //  Pinterest
  // ═══════════════════════════════════════════════════
  { host: /pinterest\.(com|co\.\w+)$/i, path: /\/pin\// },
  { host: /pin\.it$/i },

  // ═══════════════════════════════════════════════════
  //  Tumblr
  // ═══════════════════════════════════════════════════
  { host: /tumblr\.com$/i, path: /\/post\// },

  // ═══════════════════════════════════════════════════
  //  Kick
  // ═══════════════════════════════════════════════════
  { host: /kick\.com$/i, path: /\/video\// },

  // ═══════════════════════════════════════════════════
  //  Streamable
  // ═══════════════════════════════════════════════════
  { host: /streamable\.com$/i },

  // ═══════════════════════════════════════════════════
  //  Archive.org
  // ═══════════════════════════════════════════════════
  { host: /archive\.org$/i, path: /\/details\/|\/download\// },

  // ═══════════════════════════════════════════════════
  //  Loom
  // ═══════════════════════════════════════════════════
  { host: /loom\.com$/i, path: /\/share\// },

  // ═══════════════════════════════════════════════════
  //  Bandcamp
  // ═══════════════════════════════════════════════════
  { host: /bandcamp\.com$/i, path: /\/track|\/album\// },
  { host: /[^.]+\.bandcamp\.com$/i },

  // ═══════════════════════════════════════════════════
  //  Mixcloud
  // ═══════════════════════════════════════════════════
  { host: /mixcloud\.com$/i, path: /\/.+/ },

  // ═══════════════════════════════════════════════════
  //  tvcatchup
  // ═══════════════════════════════════════════════════
  { host: /tvcatchup\.com$/i },

  // ═══════════════════════════════════════════════════
  //  Japanese platforms
  // ═══════════════════════════════════════════════════
  { host: /nicovideo\.jp$/i, path: /\/watch\// },
  { host: /nico\.ms$/i },
  { host: /abema\.tv$/i, path: /\/video\/episode\// },
  { host: /tver\.jp$/i, path: /\/episodes?\// },
  { host: /hulu\.jp$/i, path: /\/watch\// },
  { host: /unext\.com$/i, path: /\/movies?\// },
  { host: /dmm\.com$/i, path: /\/digital\/videoa|\/video\// },
  { host: /lemino\.dmm\.com$/i, path: /\/movies?\// },

  // ═══════════════════════════════════════════════════
  //  Chinese platforms
  // ═══════════════════════════════════════════════════
  { host: /youku\.com$/i, path: /\/video\/show|\/v_show/ },
  { host: /iqiyi\.com$/i, path: /\/v_/ },
  { host: /iq\.com$/i, path: /\/video\// },
  { host: /v\.qq\.com$/i, path: /\/x\/cover|\/x\/page/ },
  { host: /mgtv\.com$/i, path: /\/b\// },
  { host: /weibo\.com$/i, path: /\/tv\/show|\/video\// },
  { host: /douyin\.com$/i, path: /\/video\// },
  { host: /iesdouyin\.com$/i, path: /\/share\/video\// },
  { host: /kuaishou\.com$/i, path: /\/short-video\// },
  { host: /xiaohongshu\.com$/i, path: /\/explore\// },

  // ═══════════════════════════════════════════════════
  //  Korean platforms
  // ═══════════════════════════════════════════════════
  { host: /tv\.naver\.com$/i, path: /\/v\// },
  { host: /ch\.naver\.com$/i, path: /\/moim\/|\/video\// },
  { host: /afreeca\.tv$/i, path: /\/video\/view/ },
  { host: /play\.afreeca\.tv$/i },
  { host: /tv\.kakao\.com$/i, path: /\/channel|\/v\// },
  { host: /kakao\.tv$/i },
  { host: /weverse\.io$/i, path: /\/live|\/media\// },
  { host: /vlive\.tv$/i, path: /\/video\// },

  // ═══════════════════════════════════════════════════
  //  Russian platforms
  // ═══════════════════════════════════════════════════
  { host: /vk\.com$/i, path: /\/video|\/video-/ },
  { host: /vk\.com$/i, path: /\/clip\// },
  { host: /ok\.ru$/i, path: /\/video\// },
  { host: /rutube\.ru$/i, path: /\/video|\/media\// },
  { host: /my\.mail\.ru$/i, path: /\/video\// },
  { host: /mail\.ru$/i, path: /\/video\// },

  // ═══════════════════════════════════════════════════
  //  Indian platforms
  // ═══════════════════════════════════════════════════
  { host: /hotstar\.com$/i, path: /\/in\/movies|\/in\/shows/ },
  { host: /zee5\.com$/i, path: /\/movies|\/shows/ },
  { host: /sonyliv\.com$/i, path: /\/shows|\/movies|\/originals\// },
  { host: /voot\.com$/i, path: /\/shows|\/movies|\/voot originals\// },
  { host: /jiocinema\.com$/i, path: /\/movies|\/shows|\/web-series\// },
  { host: /altbalaji\.com$/i, path: /\/shows\// },
  { host: /hoichoi\.tv$/i, path: /\/movies|\/shows\// },
  { host: /erosnow\.com$/i, path: /\/movies|\/shows\// },
  { host: /aha\.video$/i, path: /\/movies|\/shows\// },
  { host: /sunnxt\.com$/i, path: /\/movies|\/videos\// },
  { host: /spotify\.com$/i, path: /\/track|\/episode|\/show|\/playlist\// },

  // ═══════════════════════════════════════════════════
  //  Arabic / MENA platforms
  // ═══════════════════════════════════════════════════
  { host: /shahid\.mbc\.net$/i, path: /\/shows|\/movies|\/series|\/episodes\// },
  { host: /shahid\.net$/i, path: /\/shows|\/movies/ },
  { host: /starzplay\.com$/i, path: /\/movies|\/series|\/shows\// },
  { host: /play\.osnplus\.com$/i, path: /\/movies|\/shows\// },
  { host: /osnplus\.com$/i, path: /\/movies|\/shows\// },
  { host: /anghami\.com$/i, path: /\/track|\/episode|\/album|\/playlist\// },
  { host: /tod\.tv$/i, path: /\/watch\// },
  { host: /weyy\.me$/i },

  // ═══════════════════════════════════════════════════
  //  Turkish platforms
  // ═══════════════════════════════════════════════════
  { host: /puhu\.tv$/i, path: /\/izle\// },
  { host: /blutv\.com$/i, path: /\/izle\// },
  { host: /gain\.tv$/i, path: /\/izle\// },
  { host: /exxen\.com$/i, path: /\/izle\// },
  { host: /exxen\.com$/i },

  // ═══════════════════════════════════════════════════
  //  European public broadcasters
  // ═══════════════════════════════════════════════════
  { host: /rtve\.es$/i, path: /\/play|\/ver\// },
  { host: /raiplay\.it$/i, path: /\/video|\/programmi\// },
  { host: /ardmediathek\.de$/i, path: /\/video\// },
  { host: /zdf\.de$/i, path: /\/sendung|\/video\// },
  { host: /france\.tv$/i, path: /\/video\// },
  { host: /nrk\.no$/i, path: /\/tv\// },
  { host: /nrktv\.no$/i },
  { host: /svtplay\.se$/i, path: /\/video\// },
  { host: /dr\.dk$/i, path: /\/tv\/\// },
  { host: /areena\.yle\.fi$/i, path: /\/1-|\/2-|\/ohjelmat\// },
  { host: /rtbf\.be$/i, path: /\/video|\/a+\/\// },
  { host: /rtli\.nl$/i, path: /\/video\// },
  { host: /npostart\.nl$/i, path: /\/video\// },
  { host: /mediaset\.infinity\.it$/i, path: /\/video\// },

  // ═══════════════════════════════════════════════════
  //  Australian platforms
  // ═══════════════════════════════════════════════════
  { host: /iview\.abc\.net\.au$/i },
  { host: /7plus\.com\.au$/i },
  { host: /9now\.com\.au$/i },
  { host: /10play\.com\.au$/i },
  { host: /sbs\.com\.au$/i, path: /\/ondemand\/video\// },

  // ═══════════════════════════════════════════════════
  //  Latin American platforms
  // ═══════════════════════════════════════════════════
  { host: /globoplay\.globo\.com$/i, path: /\/filme|\/serie|\/video\// },
  { host: /clarovideo\.com$/i, path: /\/movie|\/series\// },
  { host: /vix\.com$/i, path: /\/peliculas|\/series|\/video\// },
  { host: /blim\.tv$/i, path: /\/series|\/peliculas\// },
  { host: /movistarplay\.com\.(\w+)$/i, path: /\/video\// },
  { host: /migoplay\.com$/i },

  // ═══════════════════════════════════════════════════
  //  Streaming services (major)
  // ═══════════════════════════════════════════════════
  { host: /netflix\.com$/i, path: /\/watch\// },
  { host: /primevideo\.com$/i, path: /\/detail\// },
  { host: /amazon\.\w+$/i, path: /\/gp\/video\/detail\// },
  { host: /disneyplus\.com$/i, path: /\/videos?\// },
  { host: /max\.com$/i, path: /\/videos?\// },
  { host: /hbomax\.com$/i, path: /\/titles\// },
  { host: /hulu\.com$/i, path: /\/watch\// },
  { host: /paramountplus\.com$/i, path: /\/shows|\/movies|\/video\// },
  { host: /peacocktv\.com$/i, path: /\/watch\// },
  { host: /tv\.apple\.com$/i, path: /\/show|\/movie|\/episode\// },
  { host: /crunchyroll\.com$/i, path: /\/episode\// },
  { host: /funimation\.com$/i, path: /\/shows\// },
  { host: /vrv\.co$/i, path: /\/watch\// },
  { host: /tubitv\.com$/i, path: /\/movies|\/watch\// },
  { host: /pluto\.tv$/i, path: /\/live-tv|\/videos?\// },
  { host: /plex\.tv$/i, path: /\/watch\// },
  { host: /kanopy\.com$/i, path: /\/watch\// },
  { host: /mubi\.com$/i, path: /\/films\// },
  { host: /criterionchannel\.com$/i, path: /\/videos\// },
  { host: /britbox\.com$/i, path: /\/video\// },
  { host: /amcplus\.com$/i, path: /\/shows|\/movies\// },
  { host: /shudder\.com$/i, path: /\/movies\// },
  { host: /curiositystream\.com$/i, path: /\/watch\// },
  { host: /magellantv\.com$/i, path: /\/watch\// },
  { host: /dazn\.com$/i, path: /\/en\/event\// },
  { host: /discoveryplus\.com$/i },
  { host: /crave\.ca$/i, path: /\/movies|\/series|\/video\// },
  { host: /stan\.com\.au$/i, path: /\/watch\// },
  { host: /wowow\.co\.jp$/i, path: /\/direct\// },
  { host: /fod\.fujitv\.com$/i },
  { host: /abema\.tv$/i, path: /\/video\// },
  { host: /tivi\.fi$/i },
  { host: /viaplay\.com$/i, path: /\/video\// },
  { host: /viaplay\.se$/i },
  { host: /viaplay\.dk$/i },
  { host: /viaplay\.no$/i },
  { host: /viaplay\.fi$/i },
  { host: /viaplay\.pl$/i },
  { host: /tv4play\.se$/i },
  { host: /viu\.com$/i, path: /\/video\// },
  { host: /viu\.com\.(\w+)$/i, path: /\/video\// },

  // ═══════════════════════════════════════════════════
  //  Sports / Live TV
  // ═══════════════════════════════════════════════════
  { host: /mlb\.com$/i, path: /\/tv\// },
  { host: /nhl\.com$/i, path: /\/video\// },
  { host: /nba\.com$/i, path: /\/watch\// },
  { host: /ufc\.com$/i, path: /\/events\// },
  { host: /espn\.com$/i, path: /\/watch\// },
  { host: /fifa\.com$/i, path: /\/fifaplus\// },

  // ═══════════════════════════════════════════════════
  //  Music streaming
  // ═══════════════════════════════════════════════════
  { host: /open\.spotify\.com$/i, path: /\/track|\/episode|\/show|\/playlist|\/album\// },
  { host: /music\.apple\.com$/i, path: /\/album|\/playlist\// },
  { host: /deezer\.com$/i, path: /\/track|\/album|\/playlist\// },
  { host: /deezer\.page\.link$/i },
  { host: /tidal\.com$/i, path: /\/track|\/album|\/playlist\// },
  { host: /pandora\.com$/i, path: /\/track|\/station|\/artist\// },
  { host: /audiomack\.com$/i, path: /\/track|\/album|\/playlist\// },
  { host: /music\.yandex\.(ru|com)$/i, path: /\/track|\/album|\/playlist|\/users\// },
  { host: /music\.amazon\.\w+$/i, path: /\/detail|\/track\// },
  { host: /qobuz\.com$/i, path: /\/track|\/album\// },
  { host: /napster\.com$/i, path: /\/track|\/album|\/playlist\// },
  { host: /jiosaavn\.com$/i, path: /\/song|\/album|\/playlist\// },
  { host: /gaana\.com$/i, path: /\/song|\/album|\/playlist\// },
  { host: /wynk\.in$/i, path: /\/music\/album|\/music\/song\// },
  { host: /iheart\.com$/i, path: /\/live\// },
  { host: /radioline\.co$/i },

  // ═══════════════════════════════════════════════════
  //  Podcast platforms
  // ═══════════════════════════════════════════════════
  { host: /podcasts\.apple\.com$/i, path: /\/id\// },
  { host: /podcasts\.google\.com$/i, path: /\/episode\// },
  { host: /podcasts\.spotify\.com$/i },
  { host: /overcast\.fm$/i },
  { host: /pocketcasts\.com$/i, path: /\/episode\// },

  // ═══════════════════════════════════════════════════
  //  Video hosting / creation tools
  // ═══════════════════════════════════════════════════
  { host: /wistia\.com$/i, path: /\/medias\// },
  { host: /vidyard\.com$/i, path: /\/watch\// },
  { host: /sproutvideo\.com$/i, path: /\/videos\// },
  { host: /vimeo\.com$/i, path: /\/review\/\d+/ },

  // ═══════════════════════════════════════════════════
  //  Adult platforms (yt-dlp supported)
  // ═══════════════════════════════════════════════════
  { host: /pornhub\.com$/i, path: /\/view_video/ },
  { host: /xvideos\.com$/i, path: /\/video\d+/ },
  { host: /xhamster\.com$/i, path: /\/videos\// },
  { host: /redtube\.com$/i, path: /\/\d+/ },
  { host: /youporn\.com$/i, path: /\/watch\// },
  { host: /spankbang\.com$/i, path: /\/.*\/video\// },
  { host: /eporner\.com$/i, path: /\/video-/ },
  { host: /hclips\.com$/i, path: /\/videos\// },
  { host: /txxx\.com$/i, path: /\/videos\// },
  { host: /hdzog\.com$/i, path: /\/videos\// },
  { host: /missav\.com$/i, path: /\/\w+\/\w+\.html/ },
];

function normalizeUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return url;

  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(url)) return url;

  if (/^\/\/./.test(url)) return 'https:' + url;

  if (
    /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*(:\d{1,5})?(\/|$|\?|#)/.test(url)
  ) {
    return 'https://' + url;
  }

  return url;
}

export function detectUrlType(url: string): UrlType {
  const normalized = normalizeUrl(url);
  if (!normalized) return 'unknown';

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return 'download';
  }

  const protocol = parsed.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return 'unknown';

  const hostname = parsed.hostname
    .replace(/^www\./, '')
    .replace(/^m\./, '')
    .replace(/^mobile\./, '')
    .replace(/^lite\./, '');
  const fullPath = parsed.pathname + parsed.search;

  for (const pattern of MEDIA_PATTERNS) {
    if (!pattern.host.test(hostname)) continue;
    if (pattern.path) {
      if (pattern.path.test(fullPath)) return 'media';
    } else {
      return 'media';
    }
  }

  return 'download';
}

export function getDialogForUrl(url: string): string {
  const type = detectUrlType(url);
  if (type === 'media') return 'mediaDownload';
  return 'addDownload';
}
