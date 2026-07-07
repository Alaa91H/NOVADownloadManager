import { AppSettings, Queue } from './types/desktop-ui.types';

export const initialQueues: Queue[] = [
  {
    id: 'main',
    name: 'Main Queue',
    active: true,
    scheduled: false,
    scheduleType: 'daily',
    maxActive: 1,
    scheduleCompleted: false,
    startTime: '00:00',
    endTime: '23:59',
    days: [0, 1, 2, 3, 4, 5, 6],
    limitSpeed: false,
    speedLimitKbs: 0,
    oneTimeLimit: false,
    shutdownOnComplete: false,
    hangupOnComplete: false,
    retryCount: 3,
    downloadOrder: [],
  },
];

export const initialSettings: AppSettings = {
  general: {
    runOnStartup: false,
    integrateWithBrowsers: {
      chrome: false,
      edge: false,
      firefox: false,
      safari: false,
    },
    monitorClipboard: false,
    showTrayIcon: true,
    confirmOnDelete: true,
    checkUpdates: false,
  },
  fileTypes: {
    extensions: {
      document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub'],
      program: ['exe', 'msi', 'apk', 'dmg', 'pkg', 'bat', 'sh'],
      compressed: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'iso', 'cab'],
      video: ['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'ts'],
      audio: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma'],
    },
    autoDownloadMaxSizeMb: 0,
  },
  connection: {
    connectionType: 'lan',
    maxConnections: 0,
    enableProxy: false,
    proxyHost: '',
    proxyPort: '',
    proxyUser: '',
    proxyPass: '',
    speedLimiter: {
      enabled: false,
      maxSpeedKbs: 0,
    },
  },
  saveAndCategories: {
    defaultFolder: '',
    tempFolder: '',
    categoryFolders: {
      document: '',
      program: '',
      compressed: '',
      video: '',
      audio: '',
      other: '',
    },
  },
  sounds: {
    enabled: false,
    onComplete: 'chime',
    onError: 'alert',
    onQueueFinished: 'chime',
    onStart: 'tap',
    onNotification: 'soft',
    volume: 60,
    toastSound: true,
    customCompleteDataUrl: '',
    customErrorDataUrl: '',
    customQueueFinishedDataUrl: '',
    customNotificationDataUrl: '',
  },
  ui: {
    toolbar: {
      newDownload: { display: 'full', showDropdown: true },
      resume: { display: 'full', showDropdown: true },
      stop: { display: 'full', showDropdown: true },
      delete: { display: 'full', showDropdown: true },
      scheduler: { display: 'full', showDropdown: false },
    },
    statusBar: {
      speed: { visible: true },
      counts: { visible: true },
      downloaded: { visible: true },
      daemon: { visible: true },
      browser: { visible: true },
      telegram: { visible: true },
      clipboard: { visible: true },
      speedLimiter: { visible: true },
      notifications: { visible: true },
    },
    customButtons: [],
  },
  keyboardShortcuts: {
    enabled: true,
    bindings: {
      addDownload: 'Ctrl+N',
      batchDownload: 'Ctrl+Shift+N',
      focusSearch: 'Ctrl+F',
      selectAllDownloads: 'Ctrl+A',
      resumeSelected: 'Ctrl+R',
      resumeAll: 'Ctrl+Shift+R',
      stopSelected: 'Ctrl+S',
      stopAll: 'Ctrl+Shift+S',
      deleteSelected: 'Delete',
      deleteCompleted: 'Ctrl+Shift+Delete',
      openSettings: 'Ctrl+,',
      openScheduler: 'Ctrl+L',
      toggleNotifications: 'Ctrl+M',
      toggleSpeedLimiter: 'Ctrl+Shift+L',
    },
  },
  advanced: {
    dynamicAllocation: true,
    browserInterceptKeys: 'Alt',
    logLevel: 'info',
    bufferSizeKb: 256,
  },
  extra: {
    language: 'en',
    timezone: 'system',
    duplicateAction: 'rename',
    checkRanges: true,
    warnOnDuplicate: true,
    openOnComplete: false,
    openFolderOnComplete: false,
    virusScan: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NOVA/0.1.0',
    dnsResolver: 'system',
    dnsCustomResolver: '',
    forceIpv4: false,
    vpnEnabled: false,
    vpnMode: 'system',
    vpnProxyUrl: '',
    vpnBindAddress: '',
    vpnKillSwitch: true,
    vpnDnsProtection: true,
    homePage: '',
    searchEngine: 'google',
    saveHistory: true,
    block3rdPartyCookies: true,
    clearHistoryOnExit: false,
    clearCookiesOnExit: false,
    mediaMonitorEnabled: true,
    captureHls: true,
    captureDash: true,
    downloadSubtitles: false,
    videoQuality: 'best',
    subtitleLanguage: '',
    ffmpegPath: '',
    ffmpegAutoMerge: true,
    ffmpegDeleteSegments: true,
    torrentEnabled: false,
    torrentDht: false,
    torrentPex: false,
    torrentEncrypt: false,
    torrentPort: '',
    torrentMaxPeers: '',
    torrentSeeding: false,
    torrentBatteryStop: true,
    torrentRatioLimit: '',
    torrentUploadSpeed: '',
    tgEnabled: false,
    tgBotToken: '',
    tgChatId: '',
    tgEventStarted: false,
    tgEventCompleted: false,
    tgEventFailed: false,
    tgEventQueueCompleted: false,
    tgFullControl: false,
    tgApiBase: 'https://api.telegram.org',
    tgFileUploadLimitMb: 50,
    smtpHost: '',
    smtpPort: '',
    smtpUser: '',
    smtpPass: '',
    webhookUrl: '',
    webhookAuth: '',
    webhookActive: false,
    smtpActive: false,
    daemonPort: '3199',
    daemonBindAddress: '127.0.0.1',
    experimentalFeatures: false,
    encryptAccessTokens: true,
    redactTokens: true,
    preventClipboardHistory: true,
    browserPairingToken: '',
    bindLocalhostOnly: true,
    rejectExternalRequests: true,
    trustedOrigins: 'localhost, 127.0.0.1',
    autoReconnectDaemon: true,
    enableSse: true,
    ignoreSites: '',
  },
};

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes)) return 'Unknown';
  if (bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let temp = bytes;
  while (temp >= k && i < sizes.length - 1) {
    temp /= k;
    i += 1;
  }
  return `${String(parseFloat(temp.toFixed(2)))} ${sizes[i]}`;
};

export const formatSpeed = (bytesPerSec: number): string => {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  let temp = bytesPerSec;
  while (temp >= k && i < sizes.length - 1) {
    temp /= k;
    i += 1;
  }
  return `${String(parseFloat(temp.toFixed(1)))} ${sizes[i]}`;
};

export const formatTimeLeft = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Unknown';
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${String(minutes)}m ${String(remainingSeconds)}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${String(hours)}h ${String(remainingMinutes)}m`;
};

export const fileTypeMetadata = {
  document: { label: 'Documents', color: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' },
  program: { label: 'Programs', color: 'bg-blue-500/10 text-blue-500 border-blue-500/20' },
  compressed: { label: 'Archives', color: 'bg-amber-500/10 text-amber-500 border-amber-500/20' },
  video: { label: 'Video', color: 'bg-rose-500/10 text-rose-500 border-rose-500/20' },
  audio: { label: 'Audio', color: 'bg-purple-500/10 text-purple-500 border-purple-500/20' },
  other: { label: 'Other', color: 'bg-slate-500/10 text-slate-400 border-slate-500/20' },
};

export const statusMetadata = {
  downloading: { label: 'Downloading', color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  completed: { label: 'Completed', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  paused: { label: 'Paused', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  queued: { label: 'Queued', color: 'text-purple-400 bg-purple-400/10 border-purple-400/20' },
  error: { label: 'Error', color: 'text-rose-400 bg-rose-400/10 border-rose-400/20' },
};
