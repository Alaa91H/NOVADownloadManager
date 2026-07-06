export type FileType = 'document' | 'program' | 'compressed' | 'video' | 'audio' | 'other';

export type DownloadStatus = 'downloading' | 'completed' | 'paused' | 'queued' | 'error';

export type DownloadEngine = 'aria2' | 'yt-dlp';

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
  | 'youtubeDownload'
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
  | 'plus'
  | 'layers'
  | 'play'
  | 'stop'
  | 'trash'
  | 'settings'
  | 'telegram'
  | 'bell'
  | 'clock'
  | 'globe'
  | 'video';

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
  cookies?: string;
  cookiesFromBrowser?: string;
  userAgent?: string;
  referer?: string;
  headers?: string;
  rateLimitKbs?: number;
  retries?: number;
  fragmentRetries?: number;
  concurrentFragments?: number;
  sleepIntervalSec?: number;
  maxSleepIntervalSec?: number;
  downloadSections?: string;
  matchFilter?: string;
  remuxFormat?: string;
  extraArgs?: string;
}

export interface DirectDownloadOptions {
  userAgent?: string;
  referer?: string;
  headers?: string;
  cookies?: string;
  proxy?: string;
  username?: string;
  password?: string;
  checksum?: string;
  speedLimitKbs?: number;
  retryCount?: number;
  retryDelaySec?: number;
  timeoutSec?: number;
  connectTimeoutSec?: number;
  minSplitSize?: string;
  fileAllocation?: 'none' | 'prealloc' | 'falloc' | 'trunc';
  allowOverwrite?: boolean;
  autoFileRenaming?: boolean;
  conditionalGet?: boolean;
  remoteTime?: boolean;
  contentDisposition?: boolean;
  parameterizedUri?: boolean;
  rawOptions?: string;
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
    speedLimiter: {
      enabled: boolean;
      maxSpeedKbs: number;
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
    forceIpv4: boolean;
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

export type AppPage = 'downloads' | 'settings' | 'scheduler';

export interface AppThemeSettings {
  theme: AppTheme;
  density: 'compact' | 'normal' | 'dense';
  accent: 'blue' | 'emerald' | 'amber' | 'crimson' | 'violet';
  sidebar: 'expanded' | 'collapsed';
  progress: 'bar' | 'circle' | 'percentage';
  contrast: 'normal' | 'high';
  motion: 'enabled' | 'reduced';
  blur: 'enabled' | 'disabled';
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
