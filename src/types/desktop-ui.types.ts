export type FileType = 'document' | 'program' | 'compressed' | 'video' | 'audio' | 'other';

export type DownloadStatus = 'downloading' | 'completed' | 'paused' | 'pausing' | 'stopping' | 'queued' | 'error';

export type DownloadEngine = 'curl' | 'libcurl-multi' | 'yt-dlp';

export type ToolbarButtonId = 'newDownload' | 'resume' | 'stop' | 'delete' | 'scheduler';
export type ToolbarButtonDisplayMode = 'full' | 'iconOnly' | 'labelOnly' | 'hidden';
export type StatusBarItemId =
  | 'speed'
  | 'counts'
  | 'downloaded'
  | 'daemon'
  | 'browser'
  | 'telegram'
  | 'clipboard'
  | 'speedLimiter'
  | 'notifications';
export type CustomButtonAction =
  | 'addDownload'
  | 'batchDownload'
  | 'webpageGrabber'
  | 'mediaDownload'
  | 'resumeAll'
  | 'stopAll'
  | 'deleteAll'
  | 'deleteCompleted'
  | 'openSettings'
  | 'openScheduler'
  | 'toggleNotifications'
  | 'toggleSpeedLimiter'
  | 'sendSelectedToTelegram';
export type CustomButtonIcon =
  'plus' | 'layers' | 'play' | 'stop' | 'trash' | 'settings' | 'telegram' | 'bell' | 'clock' | 'globe' | 'video';

export interface ToolbarButtonSettings {
  display: ToolbarButtonDisplayMode;
  showDropdown: boolean;
}

export interface StatusBarItemSettings {
  visible: boolean;
}

export interface CustomToolbarButton {
  id: string;
  label: string;
  action: CustomButtonAction;
  icon: CustomButtonIcon;
  enabled: boolean;
  display: Exclude<ToolbarButtonDisplayMode, 'hidden'>;
}

export type KeyboardShortcutAction =
  | 'addDownload'
  | 'batchDownload'
  | 'focusSearch'
  | 'selectAllDownloads'
  | 'resumeSelected'
  | 'resumeAll'
  | 'stopSelected'
  | 'stopAll'
  | 'deleteSelected'
  | 'deleteCompleted'
  | 'openSettings'
  | 'openScheduler'
  | 'toggleNotifications'
  | 'toggleSpeedLimiter';

export interface MediaDownloadOptions {
  mode?: 'video' | 'audio';
  quality?: string;
  formatSelector?: string;
  formatSort?: string;
  audioFormat?: string;
  ffmpegEnabled?: boolean;
  ffmpegLocation?: string;
  bitrate?: string;
  outputTemplate?: string;
  playlist?: boolean;
  playlistItems?: string;
  subtitles?: boolean;
  subtitleLanguages?: string;
  autoSubtitles?: boolean;
  embedSubtitles?: boolean;
  writeThumbnail?: boolean;
  embedThumbnail?: boolean;
  writeInfoJson?: boolean;
  writeDescription?: boolean;
  splitChapters?: boolean;
  sponsorBlock?: string;
  proxy?: string;
  sourceAddress?: string;
  cookies?: string;
  cookiesFromBrowser?: string;
  userAgent?: string;
  referer?: string;
  headers?: string;
  rateLimitKbs?: number;
  retries?: number;
  fragmentRetries?: number;
  fileAccessRetries?: number;
  retrySleep?: string;
  concurrentFragments?: number;
  throttledRateKbs?: number;
  bufferSizeKbs?: number;
  httpChunkSize?: string;
  externalDownloader?: 'auto' | 'native' | 'curl' | 'ffmpeg' | (string & {});
  externalDownloaderArgs?: string;
  sleepIntervalSec?: number;
  maxSleepIntervalSec?: number;
  sleepRequestsSec?: number;
  sleepSubtitlesSec?: number;
  socketTimeoutSec?: number;
  downloadSections?: string;
  matchFilter?: string;
  remuxFormat?: string;
  downloadArchive?: string;
  breakOnExisting?: boolean;
  forceOverwrites?: boolean;
  noOverwrites?: boolean;
  restrictFilenames?: boolean;
  windowsFilenames?: boolean;
  trimFilenames?: number;
  writeComments?: boolean;
  embedMetadata?: boolean;
  embedChapters?: boolean;
  convertThumbnails?: string;
  postprocessorArgs?: string;
  extractorArgs?: string;
  compatOptions?: string;
  liveFromStart?: boolean;
  waitForVideo?: string;
  minFilesize?: string;
  maxFilesize?: string;
  maxDownloads?: number;
  username?: string;
  password?: string;
  twoFactor?: string;
  netrc?: boolean;
  geoBypassCountry?: string;
  extraArgs?: string;
}

export interface DirectDownloadOptions {
  userAgent?: string;
  referer?: string;
  headers?: string;
  cookies?: string;
  proxy?: string;
  preProxy?: string;
  noproxy?: string;
  sourceAddress?: string;
  interface?: string;
  ipResolve?: '4' | 'ipv4' | '4-only' | '6' | 'ipv6' | '6-only' | (string & {});
  proxyType?: 'socks4' | 'socks5' | 'socks4a' | 'socks5h' | (string & {});
  proxyTunnel?: boolean;
  proxyUser?: string;
  proxyPassword?: string;
  proxyAnyAuth?: string;
  proxyCaInfo?: string;
  proxyCaPath?: string;
  proxyCert?: string;
  proxyCertType?: string;
  proxyKey?: string;
  proxyKeyType?: string;
  proxyKeyPassword?: string;
  proxyCiphers?: string;
  proxyTlsMax?: string;
  proxyTlsMin?: string;
  proxyVerifyPeer?: boolean;
  proxyVerifyHost?: boolean;
  username?: string;
  password?: string;
  authType?: 'basic' | 'digest' | 'ntlm' | 'negotiate' | 'any' | (string & {});
  oauth2Bearer?: string;
  netrc?: string;
  netrcOptional?: boolean;
  netrcFile?: string;
  unrestrictedAuth?: boolean;
  speedLimitKbs?: number;
  speedLimitBytes?: number;
  lowSpeedLimitBytes?: number;
  speedTimeSec?: number;
  rate?: string;
  retryCount?: number;
  retryDelaySec?: number;
  retryMaxTimeSec?: number;
  retryAllErrors?: boolean;
  retryConnRefused?: boolean;
  timeoutSec?: number;
  connectTimeoutSec?: number;
  maxRedirs?: number;
  maxFilesize?: number;
  range?: string;
  etagSave?: string;
  etagCompare?: string;
  timeCond?: 'if-modified-since' | 'if-unmodified-since' | (string & {});
  timeValue?: number;
  remoteTime?: boolean;
  requestMethod?: string;
  data?: string;
  form?: string;
  allowOverwrite?: boolean;
  removeOnError?: boolean;
  segmented?: boolean;
  forceSingleConnection?: boolean;
  maxConnectionCache?: number;
  maxConnects?: number;
  maxHostConnections?: number;
  maxTotalConnections?: number;
  eventLoop?: 'waitPerform' | 'multiSocket' | 'multi_socket' | (string & {});
  location?: boolean;
  failWithBody?: boolean;
  httpVersion?: '1.0' | '1.1' | '2' | '2-prior-knowledge' | '3' | (string & {});
  compressed?: boolean;
  transferEncoding?: boolean;
  http09Allowed?: boolean;
  expect100TimeoutMs?: number;
  insecure?: boolean;
  caCert?: string;
  caPath?: string;
  cert?: string;
  certType?: string;
  key?: string;
  keyType?: string;
  pass?: string;
  tlsMin?: string;
  tlsMax?: string;
  ciphers?: string;
  tls13Ciphers?: string;
  sslReqd?: boolean;
  sslOptions?: string;
  sslSessionIdCache?: boolean;
  crlFile?: string;
  issuerCert?: string;
  pinnedPubKey?: string;
  ftpCreateDirs?: boolean;
  proto?: string;
  protoRedir?: string;
  dohUrl?: string;
  dohSslVerifyPeer?: boolean;
  dohSslVerifyHost?: boolean;
  dnsServers?: string;
  dnsInterface?: string;
  dnsCacheTimeoutSec?: number;
  resolve?: string[];
  connectTo?: string[];
  localPortRange?: string;
  tcpNoDelay?: boolean;
  keepaliveTimeSec?: number;
  pathAsIs?: boolean;
  globoff?: boolean;
  freshConnect?: boolean;
  forbidReuse?: boolean;
  maxAgeConn?: number;
  bufferSize?: number;
  skipExisting?: boolean;
}

export interface DownloadSegment {
  id: number;
  progress: number; // 0 to 100
  downloadedBytes: number;
  totalBytes: number;
  active: boolean;
  speed: number; // in bytes/sec
}

export interface DownloadItem {
  id: string;
  name: string;
  url: string;
  fileType: FileType;
  status: DownloadStatus;
  sizeBytes: number;
  downloadedBytes: number;
  speedBytesPerSec: number;
  timeLeftSeconds: number;
  elapsedSeconds: number;
  dateAdded: string;
  category: FileType;
  queueId: string; // 'main' | 'night' | 'fast'
  connections: number;
  resumable: boolean;
  savePath: string;
  description: string;
  segments: DownloadSegment[];
  referer?: string;
  engine?: DownloadEngine;
  engineId?: string;
  engineStatus?: string;
  errorMessage?: string;
  mediaOptions?: MediaDownloadOptions;
  directOptions?: DirectDownloadOptions;
  torrentMetadata?: {
    infoHash: string;
    mode: string;
    numPeers: number;
    numSeeders: number;
    uploadSpeed: number;
    uploadLength: number;
    seeder: boolean;
    seedRatio: number;
  };
}

export interface Queue {
  id: string;
  name: string;
  active: boolean;
  scheduled: boolean;
  scheduleType: 'once' | 'daily' | 'custom';
  maxActive: number;
  scheduleCompleted: boolean;
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  days: number[]; // 0 for Sunday, 6 for Saturday
  limitSpeed: boolean;
  speedLimitKbs: number;
  oneTimeLimit: boolean;
  shutdownOnComplete: boolean;
  hangupOnComplete: boolean;
  retryCount: number;
  downloadOrder: string[]; // List of DownloadItem ids
}

export interface AppSettings {
  general: {
    runOnStartup: boolean;
    integrateWithBrowsers: {
      chrome: boolean;
      edge: boolean;
      firefox: boolean;
      safari: boolean;
    };
    monitorClipboard: boolean;
    showTrayIcon: boolean;
    confirmOnDelete: boolean;
    checkUpdates: boolean;
  };
  fileTypes: {
    extensions: {
      document: string[];
      program: string[];
      compressed: string[];
      video: string[];
      audio: string[];
    };
    autoDownloadMaxSizeMb: number;
  };
  connection: {
    connectionType: 'lan' | 'wifi' | 'mobile_3g_4g' | 'dialup';
    maxConnections: 0 | 8 | 16 | 24 | 32;
    enableProxy: boolean;
    proxyHost: string;
    proxyPort: string;
    proxyUser: string;
    proxyPass: string;
    proxyType: string;
    proxyTunnel: boolean;
    speedLimiter: {
      enabled: boolean;
      maxSpeedKbs: number;
    };
    defaults: {
      timeoutSec: number;
      connectTimeoutSec: number;
      retryCount: number;
      retryDelaySec: number;
      maxRedirs: number;
      ipResolve: string;
      dnsServers: string;
      keepaliveTimeSec: number;
      httpVersion: string;
      insecure: boolean;
      caCert: string;
      clientCert: string;
      clientKey: string;
      tlsMin: string;
      ciphers: string;
    };
  };
  saveAndCategories: {
    defaultFolder: string;
    tempFolder: string;
    categoryFolders: {
      document: string;
      program: string;
      compressed: string;
      video: string;
      audio: string;
      other: string;
    };
  };
  sounds: {
    enabled: boolean;
    onComplete: string; // sound file name
    onError: string;
    onQueueFinished: string;
    onStart: string;
    onNotification: string;
    volume: number;
    toastSound: boolean;
    customCompleteDataUrl: string;
    customErrorDataUrl: string;
    customQueueFinishedDataUrl: string;
    customNotificationDataUrl: string;
  };
  ui: {
    toolbar: Record<ToolbarButtonId, ToolbarButtonSettings>;
    statusBar: Record<StatusBarItemId, StatusBarItemSettings>;
    customButtons: CustomToolbarButton[];
  };
  keyboardShortcuts: {
    enabled: boolean;
    bindings: Record<KeyboardShortcutAction, string>;
  };
  advanced: {
    dynamicAllocation: boolean;
    browserInterceptKeys: string; // "Alt", "Ctrl", etc
    logLevel: 'info' | 'debug' | 'error';
    bufferSizeKb: number;
  };
  extra: {
    language: string;
    timezone: string;
    duplicateAction: string;
    checkRanges: boolean;
    warnOnDuplicate: boolean;
    openOnComplete: boolean;
    openFolderOnComplete: boolean;
    virusScan: boolean;
    userAgent: string;
    dnsResolver: string;
    dnsCustomResolver: string;
    forceIpv4: boolean;
    vpnEnabled: boolean;
    vpnMode: 'system' | 'proxy' | 'bind';
    vpnProxyUrl: string;
    vpnBindAddress: string;
    vpnKillSwitch: boolean;
    vpnDnsProtection: boolean;
    homePage: string;
    searchEngine: string;
    saveHistory: boolean;
    block3rdPartyCookies: boolean;
    clearHistoryOnExit: boolean;
    clearCookiesOnExit: boolean;
    mediaMonitorEnabled: boolean;
    captureHls: boolean;
    captureDash: boolean;
    downloadSubtitles: boolean;
    videoQuality: string;
    subtitleLanguage: string;
    ffmpegPath: string;
    ffmpegAutoMerge: boolean;
    ffmpegDeleteSegments: boolean;
    torrentEnabled: boolean;
    torrentDht: boolean;
    torrentPex: boolean;
    torrentEncrypt: boolean;
    torrentPort: string;
    torrentMaxPeers: string;
    torrentSeeding: boolean;
    torrentBatteryStop: boolean;
    torrentRatioLimit: string;
    torrentUploadSpeed: string;
    tgEnabled: boolean;
    tgBotToken: string;
    tgChatId: string;
    tgEventStarted: boolean;
    tgEventCompleted: boolean;
    tgEventFailed: boolean;
    tgEventQueueCompleted: boolean;
    tgFullControl: boolean;
    tgApiBase: string;
    tgFileUploadLimitMb: number;
    smtpHost: string;
    smtpPort: string;
    smtpUser: string;
    smtpPass: string;
    webhookUrl: string;
    webhookAuth: string;
    webhookActive: boolean;
    smtpActive: boolean;
    daemonPort: string;
    daemonBindAddress: string;
    experimentalFeatures: boolean;
    encryptAccessTokens: boolean;
    redactTokens: boolean;
    preventClipboardHistory: boolean;
    browserPairingToken: string;
    bindLocalhostOnly: boolean;
    rejectExternalRequests: boolean;
    trustedOrigins: string;
    autoReconnectDaemon: boolean;
    enableSse: boolean;
    ignoreSites: string;
  };
}

export type AppTheme = 'dark' | 'light' | 'system' | 'midnight' | 'graphite' | 'nord' | 'solar';

export type AppPage = 'downloads' | 'settings' | 'scheduler' | 'mediaDownload';

export interface AppThemeSettings {
  theme: AppTheme;
  density: 'compact' | 'normal' | 'dense';
  accent: 'blue' | 'emerald' | 'amber' | 'crimson' | 'violet';
  progress: 'bar' | 'circle' | 'percentage';
  contrast: 'normal' | 'high';
}

export interface DialogState {
  active: string | null;
  payload?: unknown;
}

export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message: string;
  action?: { label: string; onClick: () => void };
}

export interface AppStoreState {
  tasks: DownloadItem[];
  queues: Queue[];
  selectedTaskId: string | null;
  workspaceView: 'all' | 'unfinished' | 'finished' | 'queued' | FileType | 'browser' | 'scheduler' | 'diagnostics';
  bridge: {
    status: 'connected' | 'connecting' | 'disconnected' | 'degraded';
    version: string;
    pid: number;
    uptime: number;
    speedLimit: number | null;
  };
  searchQuery: string;
  dialog: DialogState;
  settings: AppSettings;
  themeSettings: AppThemeSettings;
  toasts: ToastItem[];
  isLoading: boolean;
  isDegradedMode: boolean;
}
