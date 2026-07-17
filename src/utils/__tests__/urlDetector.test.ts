import { describe, it, expect } from 'vitest';
import { detectUrlType, getDialogForUrl } from '../urlDetector';

describe('detectUrlType', () => {
  describe('YouTube official', () => {
    it('detects standard YouTube URLs', () => {
      expect(detectUrlType('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('media');
      expect(detectUrlType('https://youtu.be/dQw4w9WgXcQ')).toBe('media');
      expect(detectUrlType('https://youtube.com/shorts/abc123')).toBe('media');
      expect(detectUrlType('https://www.youtube.com/live/abc123')).toBe('media');
      expect(detectUrlType('https://music.youtube.com/watch?v=abc')).toBe('media');
      expect(detectUrlType('https://www.youtube.com/playlist?list=PLxxx')).toBe('media');
      expect(detectUrlType('https://www.youtube.com/embed/abc123')).toBe('media');
      expect(detectUrlType('https://www.youtube.com/v/abc123')).toBe('media');
    });

    it('handles mobile YouTube', () => {
      expect(detectUrlType('https://m.youtube.com/watch?v=abc')).toBe('media');
      expect(detectUrlType('https://mobile.youtube.com/watch?v=abc')).toBe('media');
    });
  });

  describe('YouTube alternative frontends', () => {
    it('detects Invidious instances', () => {
      expect(detectUrlType('https://invidious.snopyta.org/watch?v=abc')).toBe('media');
      expect(detectUrlType('https://inv.tux.pizza/watch?v=abc')).toBe('media');
      expect(detectUrlType('https://vid.puffyan.us/watch?v=abc')).toBe('media');
      expect(detectUrlType('https://yewtu.be/watch?v=abc')).toBe('media');
      expect(detectUrlType('https://invidious.fdn.fr/watch?v=abc')).toBe('media');
      expect(detectUrlType('https://yt.artemislena.eu/watch?v=abc')).toBe('media');
      expect(detectUrlType('https://inv.nadeko.net/shorts/abc')).toBe('media');
      expect(detectUrlType('https://iv.datura.network/watch?v=abc')).toBe('media');
    });

    it('detects Piped instances', () => {
      expect(detectUrlType('https://piped.video/watch?v=abc')).toBe('media');
      expect(detectUrlType('https://piped.kavin.rocks/watch?v=abc')).toBe('media');
      expect(detectUrlType('https://piped.adminforge.de/watch?v=abc')).toBe('media');
      expect(detectUrlType('https://piped.hostux.net/watch?v=abc')).toBe('media');
    });
  });

  describe('Twitter/X and mirrors', () => {
    it('detects Twitter/X official', () => {
      expect(detectUrlType('https://twitter.com/user/status/123456789')).toBe('media');
      expect(detectUrlType('https://x.com/user/status/123456789')).toBe('media');
    });

    it('detects Nitter mirrors', () => {
      expect(detectUrlType('https://nitter.poast.org/user/status/123')).toBe('media');
      expect(detectUrlType('https://nitter.privacydev.net/user/status/123')).toBe('media');
      expect(detectUrlType('https://xcancel.com/user/status/123')).toBe('media');
      expect(detectUrlType('https://twiiit.com/user/status/123')).toBe('media');
      expect(detectUrlType('https://nitter.woodland.cafe/user/status/123')).toBe('media');
    });
  });

  describe('Reddit and alternatives', () => {
    it('detects Reddit official', () => {
      expect(detectUrlType('https://www.reddit.com/r/subreddit/comments/abc123/')).toBe('media');
      expect(detectUrlType('https://old.reddit.com/r/subreddit/comments/abc123/')).toBe('media');
      expect(detectUrlType('https://v.redd.it/abc123/DASH_720.mp4')).toBe('media');
    });

    it('detects Redlib instances', () => {
      expect(detectUrlType('https://redlib.catsarch.com/r/sub/comments/abc/')).toBe('media');
      expect(detectUrlType('https://redlib.tux.pizza/r/sub/comments/abc/')).toBe('media');
    });
  });

  describe('Japanese platforms', () => {
    it('detects NicoNico', () => {
      expect(detectUrlType('https://www.nicovideo.jp/watch/sm1234567')).toBe('media');
      expect(detectUrlType('https://nico.ms/sm1234567')).toBe('media');
    });

    it('detects AbemaTV', () => {
      expect(detectUrlType('https://abema.tv/video/episode/ep123')).toBe('media');
    });

    it('detects TVer', () => {
      expect(detectUrlType('https://tver.jp/episodes/ep123')).toBe('media');
    });

    it('detects Hulu Japan', () => {
      expect(detectUrlType('https://www.hulu.jp/watch/12345')).toBe('media');
    });

    it('detects U-NEXT', () => {
      expect(detectUrlType('https://video.unext.com/movies/12345')).toBe('media');
    });
  });

  describe('Chinese platforms', () => {
    it('detects Youku', () => {
      expect(detectUrlType('https://v.youku.com/video/show/id_abc')).toBe('media');
      expect(detectUrlType('https://www.youku.com/v_show/id_abc')).toBe('media');
    });

    it('detects iQIYI', () => {
      expect(detectUrlType('https://www.iqiyi.com/v_abc.html')).toBe('media');
      expect(detectUrlType('https://iq.com/video/abc')).toBe('media');
    });

    it('detects Tencent Video', () => {
      expect(detectUrlType('https://v.qq.com/x/cover/abc.html')).toBe('media');
    });

    it('detects Douyin', () => {
      expect(detectUrlType('https://www.douyin.com/video/123456')).toBe('media');
    });
  });

  describe('Korean platforms', () => {
    it('detects Naver TV', () => {
      expect(detectUrlType('https://tv.naver.com/v/12345')).toBe('media');
    });

    it('detects KakaoTV', () => {
      expect(detectUrlType('https://tv.kakao.com/channel/123/v/456')).toBe('media');
    });

    it('detects AfreecaTV', () => {
      expect(detectUrlType('https://www.afreeca.tv/video/view/12345')).toBe('media');
    });
  });

  describe('Russian platforms', () => {
    it('detects VK Video', () => {
      expect(detectUrlType('https://vk.com/video-123456_789')).toBe('media');
      expect(detectUrlType('https://vk.com/video/clip-123456_789')).toBe('media');
    });

    it('detects OK.ru', () => {
      expect(detectUrlType('https://ok.ru/video/123456789')).toBe('media');
    });

    it('detects Rutube', () => {
      expect(detectUrlType('https://rutube.ru/video/abc123/')).toBe('media');
    });
  });

  describe('Arabic / MENA platforms', () => {
    it('detects Shahid', () => {
      expect(detectUrlType('https://shahid.mbc.net/shows/show-name/episode/123')).toBe('media');
      expect(detectUrlType('https://shahid.mbc.net/movies/movie-name/123')).toBe('media');
    });

    it('detects OSN+', () => {
      expect(detectUrlType('https://play.osnplus.com/movies/movie-123')).toBe('media');
    });

    it('detects Anghami', () => {
      expect(detectUrlType('https://www.anghami.com/track/12345')).toBe('media');
    });
  });

  describe('Turkish platforms', () => {
    it('detects BluTV', () => {
      expect(detectUrlType('https://www.blutv.com/izle/series/show-123')).toBe('media');
    });

    it('detects Puhu TV', () => {
      expect(detectUrlType('https://www.puhu.tv/izle/series/show-123')).toBe('media');
    });

    it('detects EXXEN', () => {
      expect(detectUrlType('https://www.exxen.com/izle/123')).toBe('media');
    });
  });

  describe('Indian platforms', () => {
    it('detects Hotstar', () => {
      expect(detectUrlType('https://www.hotstar.com/in/movies/movie-name/12345')).toBe('media');
    });

    it('detects Zee5', () => {
      expect(detectUrlType('https://www.zee5.com/movies/details/movie-name/12345')).toBe('media');
    });

    it('detects JioCinema', () => {
      expect(detectUrlType('https://www.jiocinema.com/movies/movie-name/12345')).toBe('media');
    });

    it('detects Sony LIV', () => {
      expect(detectUrlType('https://www.sonyliv.com/shows/show-name/12345')).toBe('media');
    });
  });

  describe('Major streaming services', () => {
    it('detects Netflix', () => {
      expect(detectUrlType('https://www.netflix.com/watch/12345')).toBe('media');
    });

    it('detects Amazon Prime Video', () => {
      expect(detectUrlType('https://www.primevideo.com/detail/12345')).toBe('media');
    });

    it('detects Disney+', () => {
      expect(detectUrlType('https://www.disneyplus.com/video/12345')).toBe('media');
    });

    it('detects HBO Max', () => {
      expect(detectUrlType('https://www.max.com/videos/12345')).toBe('media');
    });

    it('detects Hulu', () => {
      expect(detectUrlType('https://www.hulu.com/watch/12345')).toBe('media');
    });

    it('detects Paramount+', () => {
      expect(detectUrlType('https://www.paramountplus.com/shows/show-name/')).toBe('media');
    });

    it('detects Apple TV+', () => {
      expect(detectUrlType('https://tv.apple.com/show/show-name/12345')).toBe('media');
    });

    it('detects Crunchyroll', () => {
      expect(detectUrlType('https://www.crunchyroll.com/episode/12345')).toBe('media');
    });

    it('detects Tubi', () => {
      expect(detectUrlType('https://tubitv.com/movies/12345')).toBe('media');
    });

    it('detects Plex', () => {
      expect(detectUrlType('https://watch.plex.tv/watch/12345')).toBe('media');
    });
  });

  describe('Music platforms', () => {
    it('detects Spotify', () => {
      expect(detectUrlType('https://open.spotify.com/track/abc123')).toBe('media');
      expect(detectUrlType('https://open.spotify.com/album/abc123')).toBe('media');
      expect(detectUrlType('https://open.spotify.com/playlist/abc123')).toBe('media');
    });

    it('detects Apple Music', () => {
      expect(detectUrlType('https://music.apple.com/us/album/album-name/12345')).toBe('media');
    });

    it('detects Deezer', () => {
      expect(detectUrlType('https://www.deezer.com/track/12345')).toBe('media');
      expect(detectUrlType('https://deezer.page.link/abc')).toBe('media');
    });

    it('detects Tidal', () => {
      expect(detectUrlType('https://tidal.com/track/12345')).toBe('media');
    });

    it('detects Bandcamp', () => {
      expect(detectUrlType('https://artist.bandcamp.com/track/song')).toBe('media');
      expect(detectUrlType('https://bandcamp.com/track/song')).toBe('media');
      expect(detectUrlType('https://bandcamp.com/album/album')).toBe('media');
    });
  });

  describe('European public broadcasters', () => {
    it('detects RTVE', () => {
      expect(detectUrlType('https://www.rtve.es/play/video/12345/')).toBe('media');
    });

    it('detects RaiPlay', () => {
      expect(detectUrlType('https://www.raiplay.it/video/12345')).toBe('media');
    });

    it('detects ARD Mediathek', () => {
      expect(detectUrlType('https://www.ardmediathek.de/video/12345')).toBe('media');
    });

    it('detects SVT Play', () => {
      expect(detectUrlType('https://www.svtplay.se/video/12345')).toBe('media');
    });
  });

  describe('Video hosting tools', () => {
    it('detects Loom', () => {
      expect(detectUrlType('https://www.loom.com/share/abc123')).toBe('media');
    });
  });

  describe('Download URLs (non-media)', () => {
    it('detects direct download URLs', () => {
      expect(detectUrlType('https://example.com/file.zip')).toBe('download');
      expect(detectUrlType('https://cdn.example.com/downloads/setup.exe')).toBe('download');
      expect(detectUrlType('https://drive.google.com/file/d/abc/view')).toBe('download');
      expect(detectUrlType('https://mega.nz/file/abc#def')).toBe('download');
      expect(detectUrlType('https://www.mediafire.com/file/abc/file.zip')).toBe('download');
      expect(detectUrlType('https://www.dropbox.com/s/abc/file.zip')).toBe('download');
      expect(detectUrlType('https://wetransfer.com/downloads/abc123/')).toBe('download');
    });

    it('handles short URL domains', () => {
      expect(detectUrlType('https://bit.ly/3abc123')).toBe('download');
      expect(detectUrlType('https://tinyurl.com/abc123')).toBe('download');
      expect(detectUrlType('https://t.co/abc123')).toBe('download');
      expect(detectUrlType('https://j.mp/abc123')).toBe('download');
      expect(detectUrlType('https://amzn.to/abc123')).toBe('download');
    });
  });

  describe('URL normalization', () => {
    it('normalizes URLs without protocol', () => {
      expect(detectUrlType('www.youtube.com/watch?v=abc')).toBe('media');
      expect(detectUrlType('example.com/file.zip')).toBe('download');
      expect(detectUrlType('youtu.be/abc123')).toBe('media');
      expect(detectUrlType('invidious.fdn.fr/watch?v=abc')).toBe('media');
      expect(detectUrlType('piped.video/watch?v=abc')).toBe('media');
      expect(detectUrlType('nitter.poast.org/user/status/123')).toBe('media');
      expect(detectUrlType('nicovideo.jp/watch/sm123')).toBe('media');
    });

    it('normalizes protocol-relative URLs', () => {
      expect(detectUrlType('//www.youtube.com/watch?v=abc')).toBe('media');
      expect(detectUrlType('//example.com/file.zip')).toBe('download');
    });

    it('handles mobile and lite prefixes', () => {
      expect(detectUrlType('https://m.youtube.com/watch?v=abc')).toBe('media');
      expect(detectUrlType('https://mobile.twitter.com/user/status/123')).toBe('media');
      expect(detectUrlType('https://lite.reddit.com/r/sub/comments/abc/')).toBe('media');
    });
  });

  describe('Unknown / invalid URLs', () => {
    it('returns unknown for empty or invalid URLs', () => {
      expect(detectUrlType('')).toBe('unknown');
      expect(detectUrlType('   ')).toBe('unknown');
      expect(detectUrlType('ftp://example.com/file')).toBe('unknown');
      expect(detectUrlType('javascript:alert(1)')).toBe('unknown');
    });

    it('returns download for plain text that looks like a domain', () => {
      expect(detectUrlType('not-a-url')).toBe('download');
      expect(detectUrlType('hello world')).toBe('download');
    });
  });
});

describe('getDialogForUrl', () => {
  it('returns mediaDownload for media URLs', () => {
    expect(getDialogForUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('mediaDownload');
  });

  it('returns addDownload for download URLs', () => {
    expect(getDialogForUrl('https://example.com/file.zip')).toBe('addDownload');
  });

  it('returns addDownload for short URLs', () => {
    expect(getDialogForUrl('https://bit.ly/3abc123')).toBe('addDownload');
  });

  it('returns mediaDownload for alternative frontend URLs', () => {
    expect(getDialogForUrl('https://piped.video/watch?v=abc')).toBe('mediaDownload');
    expect(getDialogForUrl('https://inv.tux.pizza/watch?v=abc')).toBe('mediaDownload');
    expect(getDialogForUrl('https://nitter.poast.org/user/status/123')).toBe('mediaDownload');
  });

  it('returns mediaDownload for regional platforms', () => {
    expect(getDialogForUrl('https://shahid.mbc.net/shows/show/ep1')).toBe('mediaDownload');
    expect(getDialogForUrl('https://nicovideo.jp/watch/sm123')).toBe('mediaDownload');
    expect(getDialogForUrl('https://tv.naver.com/v/12345')).toBe('mediaDownload');
  });
});
