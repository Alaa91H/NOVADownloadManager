import { AdmExtensionError } from '../core/error-classification';

// Loopback origin pattern for the local ADM daemon. Defined here (a dependency-free
// policy module that the architecture guard already allows to hold loopback literals)
// so both permission-policy and capture-profiles can reference it without importing
// webextension-polyfill or embedding a raw loopback literal.
export const ADM_LOOPBACK_ORIGIN_PATTERN = 'http://127.0.0.1/*';

const ALLOWED_OPTIONAL_PERMISSIONS = new Set(['downloads', 'webRequest', 'scripting', 'tabs', 'nativeMessaging', 'activeTab']);
const ALLOWED_EXACT_ORIGINS = new Set(['<all_urls>', ADM_LOOPBACK_ORIGIN_PATTERN, 'http://localhost/*']);
const ALLOWED_SCHEMED_HOST_ORIGIN = /^(https?:|\*:)\/\/(?:\*|\*\.[A-Za-z0-9.-]+|[A-Za-z0-9.-]+)\/\*$/;

function normalizeList(values: string[] = []): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export type ValidatedPermissionRequest = {
  permissions: string[];
  origins: string[];
};

export function validatePermissionRequest(permissions: string[] = [], origins: string[] = []): ValidatedPermissionRequest {
  const cleanPermissions = normalizeList(permissions);
  const cleanOrigins = normalizeList(origins);

  const forbiddenPermissions = cleanPermissions.filter((permission) => !ALLOWED_OPTIONAL_PERMISSIONS.has(permission));
  if (forbiddenPermissions.length) {
    throw new AdmExtensionError({
      code: 'PERMISSION_MISSING',
      message: 'The requested browser permission is not part of the ADM Extension allowlist.',
      retryable: false,
      repairHint: 'Use the Options page permission controls instead of arbitrary permission requests.',
      details: { forbiddenPermissions },
    });
  }

  const forbiddenOrigins = cleanOrigins.filter((origin) => !ALLOWED_EXACT_ORIGINS.has(origin) && !ALLOWED_SCHEMED_HOST_ORIGIN.test(origin));
  if (forbiddenOrigins.length) {
    throw new AdmExtensionError({
      code: 'PERMISSION_MISSING',
      message: 'The requested host permission is outside the ADM Extension allowlist.',
      retryable: false,
      repairHint: 'Request normal HTTP/HTTPS site access or <all_urls> from the Options page.',
      details: { forbiddenOrigins },
    });
  }

  if (cleanPermissions.length === 0 && cleanOrigins.length === 0) {
    throw new AdmExtensionError({
      code: 'VALIDATION_FAILED',
      message: 'Permission request is empty.',
      retryable: false,
    });
  }

  return { permissions: cleanPermissions, origins: cleanOrigins };
}
