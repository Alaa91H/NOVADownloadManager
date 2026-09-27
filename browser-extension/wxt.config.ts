import { readFileSync } from 'node:fs';
import { defineConfig } from 'wxt';

type PackageJson = { version?: string };
type SourceManifest = { key?: string };

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as PackageJson;
const sourceManifest = JSON.parse(readFileSync(new URL('./src/manifest.json', import.meta.url), 'utf8')) as SourceManifest;
const chromiumPublicKey = sourceManifest.key?.trim();
if (!chromiumPublicKey) throw new Error('src/manifest.json must define the stable Chromium extension public key.');
const DEFAULT_DEV_VERSION = '0.0.0';

function lastNumericBuildPart(build: string | undefined): string | undefined {
  return build
    ?.split('.')
    .filter((part) => /^\d+$/.test(part))
    .at(-1);
}

function normalizeManifestVersion(rawInput: string): string {
  const [raw = '', build = ''] = rawInput.trim().replace(/^v/, '').split('+', 2);
  if (/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(raw)) {
    const buildNumber = /^\d+\.\d+\.\d+$/.test(raw) ? lastNumericBuildPart(build) : undefined;
    return buildNumber ? `${raw}.${buildNumber}` : raw;
  }

  const prerelease = /^(\d+)\.(\d+)\.(\d+)-([0-9A-Za-z][0-9A-Za-z.-]*)$/.exec(raw);
  if (prerelease) {
    const major = prerelease[1]!;
    const minor = prerelease[2]!;
    const patch = prerelease[3]!;
    const prereleaseLabel = prerelease[4]!;
    const prereleaseNumber =
      prereleaseLabel
        .split('.')
        .filter((part) => /^\d+$/.test(part))
        .at(-1) ?? '0';
    return `${major}.${minor}.${patch}.${prereleaseNumber}`;
  }

  throw new Error(
    `Invalid extension manifest version "${rawInput}". Use a Git tag like v1.2.3, v1.2.3.4, v1.2.3-beta.4, or v1.2.3+45.`,
  );
}

function resolveManifestVersion(): string {
  return normalizeManifestVersion(process.env.WXT_VERSION ?? packageJson.version ?? DEFAULT_DEV_VERSION);
}

const version = resolveManifestVersion();
const store = process.env.WXT_STORE === '1';
const target = process.env.WXT_TARGET ?? 'chrome';

const corePermissions = ['storage', 'contextMenus', 'nativeMessaging', 'alarms', 'notifications', 'activeTab', 'declarativeNetRequest'];
const integrationPermissions = ['downloads', 'webRequest', 'scripting', 'tabs', 'declarativeNetRequestWithHostAccess'];
const NOVA_LOOPBACK_PORTS = Array.from({ length: 10 }, (_, offset) => 3199 + offset);
const NOVA_LOOPBACK_CONNECT_SOURCES = ['http', 'ws']
  .flatMap((scheme) =>
    ['127.0.0.1', 'localhost'].flatMap((host) =>
      NOVA_LOOPBACK_PORTS.map((port) => `${scheme}://${host}:${port}`),
    ),
  )
  .join(' ');

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  srcDir: 'src',
  vite: () => ({
    build: {
      chunkSizeWarningLimit: 1536,
      rolldownOptions: {
        checks: {
          pluginTimings: false,
        },
      },
    },
  }),
  zip: {
    // Artifact order: NOVA-Browser-Extension-<browser>-<version>.zip
    // (the official per-store suffix is applied downstream: .xpi / .crx).
    name: 'NOVA-Browser-Extension',
    artifactTemplate: '{{name}}-{{browser}}-{{version}}.zip',
    sourcesTemplate: '{{name}}-sources-{{version}}.zip',
  },
  hooks: {
    'build:manifestGenerated'(_wxt, manifest) {
      if (manifest.action) {
        manifest.action.default_title = '__MSG_extensionActionTitle__';
      }
    },
  },
  manifest: ({ browser }) => {
    const isFirefox = browser === 'firefox';
    const isEdge = target === 'edge';

    return {
      name: isEdge ? '__MSG_extensionNameEdge__' : '__MSG_extensionName__',
      short_name: '__MSG_extensionShortName__',
      description: '__MSG_extensionDescription__',
      version,
      // WXT generates the production manifest from this configuration rather
      // than copying src/manifest.json. Keep the public key in non-store
      // Chromium artifacts so its ID remains registered by Native Messaging.
      // Store builds use the store-assigned identity supplied to the desktop
      // release pipeline through NOVA_CHROMIUM_EXTENSION_IDS instead.
      key: !isFirefox && !store ? chromiumPublicKey : undefined,
      default_locale: 'en',
      minimum_chrome_version: isFirefox ? undefined : '116',
      permissions: store ? corePermissions : [...corePermissions, ...integrationPermissions],
      optional_permissions: store ? integrationPermissions : undefined,
      host_permissions: store ? ['http://127.0.0.1/*'] : ['<all_urls>', 'http://127.0.0.1/*'],
      optional_host_permissions: store ? ['<all_urls>'] : undefined,
      content_security_policy: {
        // Loopback-only connect-src. The transport probes the explicit
        // failover range 3199-3208, so enumerate only those origins instead
        // of widening the extension's CSP to arbitrary local services.
        extension_pages:
          `default-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; worker-src 'self'; connect-src 'self' ${NOVA_LOOPBACK_CONNECT_SOURCES}`,
      },
      browser_specific_settings: isFirefox
        ? {
            gecko: {
              id: 'nova-browser-extension@novabrowserextension.app',
              strict_min_version: '128.0',
              data_collection_permissions: { required: ['none'] },
            },
          }
        : undefined,
      icons: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
      web_accessible_resources: [
        {
          resources: ['icons/icon-48.png', 'icons/logo.png'],
          matches: ['<all_urls>'],
        },
      ],
      action: {
        default_title: '__MSG_extensionActionTitle__',
        default_icon: {
          16: 'icons/icon-16.png',
          32: 'icons/icon-32.png',
          48: 'icons/icon-48.png',
          128: 'icons/icon-128.png',
        },
      },
      commands: {
        'send-current-page-to-nova': {
          suggested_key: { default: 'Alt+Shift+D' },
          description: '__MSG_commandSendCurrentPageDescription__',
        },
      },
    };
  },
});
