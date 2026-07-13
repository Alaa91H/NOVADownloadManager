import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

type PackageJson = {version?: string};

export default defineConfig(() => {
  // Dynamically tie the version to build tags, environment variables, or the
  // tag-stamped package.json version (see scripts/apply-version.mjs).
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
  ) as PackageJson;
  const packageVersion = packageJson.version ?? '0.0.0';
  const buildTag = process.env.VITE_APP_VERSION ||
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
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      target: 'es2021',
      cssMinify: 'esbuild' as const,
      assetsInlineLimit: 8192,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom'],
            ui: ['lucide-react'],
          },
        },
      },
      chunkSizeWarningLimit: 600,
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true' ? { host: '127.0.0.1' } : false,
      // Never watch the Rust build output: watching a running nova.exe
      // crashes the FS watcher with EBUSY on Windows.
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        ignored: ['**/src-tauri/**', '**/node_modules/**', '**/dist/**'],
      },
      proxy: {
        '/api': {
          target: process.env.VITE_NOVA_DAEMON_URL || (() => {
            try { const p = fs.readFileSync(path.resolve(__dirname, '.nova-port'), 'utf-8').trim(); return `http://127.0.0.1:${p}`; } catch { return 'http://127.0.0.1:3199'; }
          })(),
          changeOrigin: true,
        },
      },
    },
  };
});
