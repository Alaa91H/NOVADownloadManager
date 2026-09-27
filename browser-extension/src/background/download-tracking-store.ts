export type TrackedDownloadNotice = 'paused' | 'complete' | 'failed';

export type PersistedTrackedDownload = {
  filename: string;
  lastNotice?: TrackedDownloadNotice;
};

export const TRACKED_DOWNLOADS_STORAGE_KEY = 'nova.trackedDownloads.v1';
export const MAX_PERSISTED_TRACKED_DOWNLOADS = 100;

function isNotice(value: unknown): value is TrackedDownloadNotice {
  return value === 'paused' || value === 'complete' || value === 'failed';
}

function sanitizeFilename(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const filename = value.trim().slice(0, 512);
  return filename || undefined;
}

export function deserializeTrackedDownloads(value: unknown): Map<number, PersistedTrackedDownload> {
  const result = new Map<number, PersistedTrackedDownload>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [rawId, rawEntry] of Object.entries(value)) {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id < 0 || !rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as Record<string, unknown>;
    const filename = sanitizeFilename(entry.filename);
    if (!filename) continue;
    result.set(id, { filename, lastNotice: isNotice(entry.lastNotice) ? entry.lastNotice : undefined });
    if (result.size >= MAX_PERSISTED_TRACKED_DOWNLOADS) break;
  }
  return result;
}

export function serializeTrackedDownloads(
  downloads: Map<number, PersistedTrackedDownload>,
): Record<string, PersistedTrackedDownload> {
  const entries = [...downloads.entries()].slice(-MAX_PERSISTED_TRACKED_DOWNLOADS);
  return Object.fromEntries(entries.map(([id, entry]) => [id, {
    filename: sanitizeFilename(entry.filename) ?? 'download',
    ...(entry.lastNotice ? { lastNotice: entry.lastNotice } : {}),
  }]));
}

export async function loadTrackedDownloads(): Promise<Map<number, PersistedTrackedDownload>> {
  try {
    const stored = await browser.storage.local.get(TRACKED_DOWNLOADS_STORAGE_KEY) as Record<string, unknown>;
    return deserializeTrackedDownloads(stored[TRACKED_DOWNLOADS_STORAGE_KEY]);
  } catch {
    return new Map();
  }
}

export async function saveTrackedDownloads(downloads: Map<number, PersistedTrackedDownload>): Promise<void> {
  try {
    await browser.storage.local.set({
      [TRACKED_DOWNLOADS_STORAGE_KEY]: serializeTrackedDownloads(downloads),
    });
  } catch {
    // Persistence is best effort; the in-memory observer remains authoritative.
  }
}
