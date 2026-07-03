import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  // Dynamically tie the version to build tags, environment variables, or dynamic build info
  const buildTag = process.env.VITE_APP_VERSION || 
                   process.env.CI_COMMIT_TAG || 
                   process.env.GITHUB_REF_NAME || 
                   process.env.BUILD_TAG || 
                   process.env.VERSION || 
                   'v0.1.0';

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(buildTag),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom'],
            ui: ['lucide-react', 'motion'],
          },
        },
      },
      chunkSizeWarningLimit: 600,
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
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
