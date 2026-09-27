import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig } from 'vite';

type PackageJson = { version?: string };

export default defineConfig(() => {
  // Dynamically tie the version to build tags, environment variables, or the
  // tag-stamped package.json version (see scripts/apply-version.mjs).
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf-8'),
  ) as PackageJson;
  const packageVersion = packageJson.version ?? '0.0.0';
  const buildTag =
    process.env.VITE_APP_VERSION ||
    process.env.CI_COMMIT_TAG ||
    process.env.GITHUB_REF_NAME ||
    process.env.BUILD_TAG ||
    process.env.VERSION ||
    `v${packageVersion}`;

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(buildTag),
    },
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    build: {
      target: 'es2021',
      cssMinify: 'esbuild' as const,
      assetsInlineLimit: 8192,
      // Rolldown emits an informational PLUGIN_TIMINGS breakdown on every build
      // (dominated by Tailwind CSS processing). It's a diagnostic, not a defect;
      // disable the check so builds are warning-free.
      rolldownOptions: {
        checks: {
          pluginTimings: false,
        },
      },
      rollupOptions: {
        output: {
          // Vite 8 (Rolldown) only accepts the function form of manualChunks.
          manualChunks(moduleId: string) {
            if (moduleId.includes('node_modules/react') || moduleId.includes('node_modules/scheduler')) {
              return 'vendor';
            }
            if (moduleId.includes('node_modules/zustand')) {
              return 'zustand';
            }
            if (moduleId.includes('node_modules/lucide-react')) {
              return 'ui';
            }
            return undefined;
          },
        },
      },
      chunkSizeWarningLimit: 600,
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true' ? { host: '127.0.0.1' } : false,
      // Never watch the Rust build output: watching a running nova.exe
      // crashes the FS watcher with EBUSY on Windows.
      watch:
        process.env.DISABLE_HMR === 'true'
          ? null
          : {
              ignored: ['**/src-tauri/**', '**/node_modules/**', '**/dist/**'],
            },
      proxy: {
        '/api': {
          target:
            process.env.VITE_NOVA_DAEMON_URL ||
            (() => {
              try {
                const p = fs.readFileSync(path.resolve(import.meta.dirname, '.nova-port'), 'utf-8').trim();
                return `http://127.0.0.1:${p}`;
              } catch {
                return 'http://127.0.0.1:3199';
              }
            })(),
          changeOrigin: true,
        },
      },
    },
  };
});
