const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
// NOTE: This key storage location is a compromise. Ideally, the encryption
// key would live in the Tauri secure-store plugin (OS keychain). However,
// secure-store requires async IPC and is not available at module init time.
// We use sessionStorage (cleared on tab close) instead of localStorage
// (persists forever) as a defense-in-depth measure. In production, migrate
// to @tauri-apps/plugin-secure-store when the IPC initialization ordering
// allows it.
const KEY_STORAGE_KEY = 'nova_encryption_key_v1';
const ENCRYPTED_PREFIX = 'enc:';

const CREDENTIAL_FIELDS = [
  ['connection', 'proxyPass'],
  ['connection', 'proxyUser'],
  ['extra', 'tgBotToken'],
  ['extra', 'smtpUser'],
  ['extra', 'smtpPass'],
] as const;

function isCryptoAvailable(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return typeof window !== 'undefined' && window.crypto?.subtle !== undefined;
}

async function getOrCreateKey(): Promise<CryptoKey | null> {
  if (!isCryptoAvailable()) return null;

  let raw = window.sessionStorage.getItem(KEY_STORAGE_KEY);
  if (!raw) {
    const key = await crypto.subtle.generateKey({ name: ALGORITHM, length: KEY_LENGTH }, true, ['encrypt', 'decrypt']);
    const exported = await crypto.subtle.exportKey('raw', key);
    raw = btoa(String.fromCharCode(...new Uint8Array(exported)));
    window.sessionStorage.setItem(KEY_STORAGE_KEY, raw);
  }

  const rawBytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey('raw', rawBytes, { name: ALGORITHM, length: KEY_LENGTH }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptValue(plaintext: string): Promise<string> {
  if (!plaintext) return plaintext;
  if (!isCryptoAvailable()) return plaintext;

  const key = await getOrCreateKey();
  if (!key) return plaintext;

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded);

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return ENCRYPTED_PREFIX + btoa(String.fromCharCode(...combined));
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

export async function decryptValue(ciphertext: string): Promise<string> {
  if (!ciphertext || !ciphertext.startsWith(ENCRYPTED_PREFIX)) return ciphertext;
  if (!isCryptoAvailable()) return ciphertext;

  const key = await getOrCreateKey();
  if (!key) return ciphertext;

  const raw = ciphertext.slice(ENCRYPTED_PREFIX.length);
  const combined = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

function getNested(obj: Record<string, unknown>, path: readonly string[]): string | undefined {
  let current: unknown = obj;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

function setNested<T extends Record<string, unknown>>(obj: T, path: readonly string[], value: string): T {
  const result = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  let current = result;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    if (!current[segment] || typeof current[segment] !== 'object') {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
  return result as T;
}

export async function encryptCredentials<T extends Record<string, unknown>>(settings: T): Promise<T> {
  const extra = settings.extra as Record<string, unknown> | undefined;
  const enabled = extra?.encryptAccessTokens === true;
  if (!enabled) return settings;

  let result = settings;
  for (const path of CREDENTIAL_FIELDS) {
    const val = getNested(result, path);
    if (val && !isEncrypted(val)) {
      const encrypted = await encryptValue(val);
      result = setNested(result, path, encrypted);
    }
  }
  return result;
}

export async function decryptCredentials<T extends Record<string, unknown>>(settings: T): Promise<T> {
  let result = settings;
  for (const path of CREDENTIAL_FIELDS) {
    const val = getNested(result, path);
    if (val && isEncrypted(val)) {
      const decrypted = await decryptValue(val);
      result = setNested(result, path, decrypted);
    }
  }
  return result;
}
