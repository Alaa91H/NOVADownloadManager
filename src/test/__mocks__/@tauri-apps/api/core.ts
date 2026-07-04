import { vi } from 'vitest';

export const isTauri = () => false;

export const invoke = vi.fn((cmd: string, _args?: Record<string, unknown>) => {
  switch (cmd) {
    case 'get_version':
      return '0.1.0';
    case 'get_daemon_url':
      return 'http://127.0.0.1:3199';
    case 'get_downloads_dir':
      return 'C:\\Users\\Downloads';
    case 'get_browser_extension_paths':
      return {
        dev_path: '../../browser-extension',
        resource_path: 'C:\\Program Files\\Nova Download Manager\\resources\\browser-extension',
      };
    case 'restart_daemon':
      return null;
    default:
      return undefined;
  }
});
