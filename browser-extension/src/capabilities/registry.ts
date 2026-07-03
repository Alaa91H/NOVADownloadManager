export const ADM_EXTENSION_CAPABILITY_REGISTRY = [
  'candidate.directUrl',
  'candidate.torrent',
  'candidate.magnet',
  'candidate.hls',
  'candidate.dash',
  'task.add',
  'task.addBatch',
  'task.pause',
  'task.resume',
  'task.cancel',
  'events.sse',
  'events.websocket',
  'settings.snapshot',
  'page.extract',
  'refreshAddress.candidate',
  'refreshAddress.apply',
] as const;

export type AdmExtensionCapability = typeof ADM_EXTENSION_CAPABILITY_REGISTRY[number];
