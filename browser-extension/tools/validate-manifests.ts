import { readJson, pathExists } from './fs-utils.js';
import { dirname, join } from 'node:path';

type BrowserTarget = 'chromium' | 'edge' | 'firefox';

type Manifest = {
  manifest_version?: number;
  version?: string;
  name?: string;
  short_name?: string;
  background?: { service_worker?: string; scripts?: string[]; type?: string };
  permissions?: string[];
  host_permissions?: string[];
  optional_permissions?: string[];
  optional_host_permissions?: string[];
  content_security_policy?: { extension_pages?: string } | string;
  browser_specific_settings?: unknown;
  default_locale?: string;
};

const requiredLocaleMessages = [
  'extensionName',
  'extensionShortName',
  'extensionActionTitle',
  'extensionDescription',
  'commandSendCurrentPageDescription',
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hasMv3Background(target: BrowserTarget, bg: Manifest['background']): boolean {
  if (!bg) return false;
  if (target === 'firefox') return Boolean(bg.service_worker) || (Array.isArray(bg.scripts) && bg.scripts.length > 0);
  return Boolean(bg.service_worker) && !bg.scripts;
}

async function validateTarget(target: BrowserTarget, path: string): Promise<void> {
  assert(await pathExists(path), `${path} does not exist. Run pnpm release:artifacts after packaging.`);
  const manifest = await readJson<Manifest>(path);

  assert(manifest.manifest_version === 3, `${target}: expected Manifest V3.`);
  assert(manifest.name === '__MSG_extensionName__' || manifest.name === '__MSG_extensionNameEdge__' || manifest.name === 'NOVA Download Manager Extension' || manifest.name === 'NOVA Download Manager Extension for Edge', `${target}: expected NOVA-extension product name or localized manifest token.`);
  assert(manifest.short_name === '__MSG_extensionShortName__' || manifest.short_name === 'NOVA Extension', `${target}: expected short_name NOVA Extension or localized manifest token.`);
  assert(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version), `${target}: invalid manifest version.`);
  assert(hasMv3Background(target, manifest.background), `${target}: missing MV3 background entry.`);
  assert(!manifest.background?.scripts || target === 'firefox', `${target}: background.scripts is not valid for this MV3 target.`);

  if (target === 'edge') {
    assert(manifest.name === '__MSG_extensionNameEdge__' || manifest.name === 'NOVA Download Manager Extension for Edge', 'edge: expected Edge-specific manifest name.');
  }

  if (manifest.default_locale) {
    const messagesPath = join(dirname(path), '_locales', manifest.default_locale, 'messages.json');
    assert(await pathExists(messagesPath), `${target}: default_locale is ${manifest.default_locale}, but ${messagesPath} is missing.`);
    const messages = await readJson<Record<string, { message?: string }>>(messagesPath);
    for (const key of requiredLocaleMessages) {
      assert(typeof messages[key]?.message === 'string' && messages[key]!.message!.length > 0, `${target}: missing ${key} locale message.`);
    }
  }

  const csp = typeof manifest.content_security_policy === 'string'
    ? manifest.content_security_policy
    : manifest.content_security_policy?.extension_pages ?? '';
  assert(!/unsafe-eval|unsafe-inline/i.test(csp), `${target}: CSP must not contain unsafe-eval or unsafe-inline.`);

  const requiredPermissions = new Set(manifest.permissions ?? []);
  for (const permission of ['storage', 'contextMenus', 'alarms', 'notifications', 'nativeMessaging']) {
    assert(requiredPermissions.has(permission), `${target}: missing required permission ${permission}.`);
  }

  if (target === 'firefox') {
    assert(Boolean(manifest.browser_specific_settings), 'firefox: missing browser_specific_settings.');
  }

  console.log(`${target}: manifest validation passed (${manifest.version}).`);
}

await validateTarget('chromium', 'dist/chromium/manifest.json');
await validateTarget('edge', 'dist/edge/manifest.json');
await validateTarget('firefox', 'dist/firefox/manifest.json');
