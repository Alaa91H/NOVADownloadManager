export interface DownloadProfileOption {
  id: string;
  name: string;
  description?: string;
}

const MAX_ID_LENGTH = 96;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 320;

function asDisplayText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes daemon-provided profile metadata for display. Profile selection
 * remains server-authoritative: malformed/duplicate entries are omitted before
 * they can become selectable UI values.
 */
export function normalizeDownloadProfiles(value: unknown): DownloadProfileOption[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const profiles: DownloadProfileOption[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const id = asDisplayText(candidate.id, MAX_ID_LENGTH);
    if (!id || seen.has(id)) continue;

    const name = asDisplayText(candidate.name, MAX_NAME_LENGTH) ?? id;
    const description = asDisplayText(candidate.description, MAX_DESCRIPTION_LENGTH);
    seen.add(id);
    profiles.push(description ? { id, name, description } : { id, name });
  }

  return profiles.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/** Returns a selectable active id only when it exists in the normalized list. */
export function selectActiveDownloadProfile(value: unknown, profiles: DownloadProfileOption[]): string | undefined {
  const id = asDisplayText(value, MAX_ID_LENGTH);
  return id && profiles.some((profile) => profile.id === id) ? id : undefined;
}
