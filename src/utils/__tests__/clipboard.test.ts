import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';
import {
  extractFirstHttpUrl,
  readClipboardText,
  writeClipboardText,
  clearClipboardText,
  clearClipboardIfTextMatches,
} from '../clipboard';

// Top-level module mocks (hoisted) so the Tauri detection and clipboard-manager
// plugin can be controlled per test via vi.mocked().
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: vi.fn(() => false),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(),
  writeText: vi.fn(),
  clear: vi.fn(),
}));

const mockIsTauri = vi.mocked(isTauri);
const mockReadText = vi.mocked((await import('@tauri-apps/plugin-clipboard-manager')).readText);
const mockWriteText = vi.mocked((await import('@tauri-apps/plugin-clipboard-manager')).writeText);
const mockClear = vi.mocked((await import('@tauri-apps/plugin-clipboard-manager')).clear);

beforeEach(() => {
  vi.clearAllMocks();
  mockIsTauri.mockReturnValue(false);
  // jsdom does not implement navigator.clipboard; install a working stub.
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      readText: vi.fn().mockResolvedValue(''),
      writeText: vi.fn().mockResolvedValue(undefined),
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractFirstHttpUrl', () => {
  it('extracts http URL from text', () => {
    expect(extractFirstHttpUrl('Check this: http://example.com/file.zip')).toBe('http://example.com/file.zip');
  });

  it('extracts https URL from text', () => {
    expect(extractFirstHttpUrl('https://example.com/file.zip')).toBe('https://example.com/file.zip');
  });

  it('extracts URL with path', () => {
    expect(extractFirstHttpUrl('Download at https://cdn.example.com/downloads/setup.exe?ver=1.0')).toBe(
      'https://cdn.example.com/downloads/setup.exe?ver=1.0',
    );
  });

  it('strips trailing punctuation', () => {
    expect(extractFirstHttpUrl('Visit https://example.com, please')).toBe('https://example.com');
    expect(extractFirstHttpUrl('Check https://example.com; it works')).toBe('https://example.com');
  });

  it('returns null when no URL present', () => {
    expect(extractFirstHttpUrl('no url here')).toBeNull();
    expect(extractFirstHttpUrl('')).toBeNull();
  });

  it('extracts first URL when multiple present', () => {
    const result = extractFirstHttpUrl('https://first.com and https://second.com');
    expect(result).toBe('https://first.com');
  });

  it('handles URLs in brackets', () => {
    expect(extractFirstHttpUrl('See <https://example.com> for details')).toBe('https://example.com');
  });
});

describe('browser clipboard operations (non-Tauri)', () => {
  it('reads text from navigator.clipboard', async () => {
    const readText = vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('clipboard content');
    await expect(readClipboardText()).resolves.toBe('clipboard content');
    expect(readText).toHaveBeenCalled();
    expect(mockReadText).not.toHaveBeenCalled();
  });

  it('writes text through navigator.clipboard', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await expect(writeClipboardText('hello')).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('clears text through navigator.clipboard', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await expect(clearClipboardText()).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith('');
  });

  it('clears the clipboard when the current text matches the sensitive text', async () => {
    vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('https://secret.link');
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await clearClipboardIfTextMatches('  https://secret.link  ');
    expect(writeText).toHaveBeenCalledWith('');
  });

  it('does nothing when the sensitive text is empty', async () => {
    const readText = vi.spyOn(navigator.clipboard, 'readText');
    await clearClipboardIfTextMatches('   ');
    expect(readText).not.toHaveBeenCalled();
  });

  it('does not clear when the clipboard holds different text', async () => {
    vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('unrelated content');
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await clearClipboardIfTextMatches('https://secret.link');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('swallows clipboard read failures in best-effort cleanup', async () => {
    vi.spyOn(navigator.clipboard, 'readText').mockRejectedValue(new Error('denied'));
    await expect(clearClipboardIfTextMatches('https://secret.link')).resolves.toBeUndefined();
  });
});

describe('tauri clipboard path', () => {
  beforeEach(() => {
    mockIsTauri.mockReturnValue(true);
  });

  it('reads text through the clipboard-manager plugin', async () => {
    mockReadText.mockResolvedValue('native content');
    await expect(readClipboardText()).resolves.toBe('native content');
    expect(mockReadText).toHaveBeenCalled();
  });

  it('returns empty string when the native read fails', async () => {
    mockReadText.mockRejectedValue(new Error('empty clipboard'));
    await expect(readClipboardText()).resolves.toBe('');
  });

  it('writes text through the plugin', async () => {
    mockWriteText.mockResolvedValue(undefined);
    await expect(writeClipboardText('native')).resolves.toBeUndefined();
    expect(mockWriteText).toHaveBeenCalledWith('native');
  });

  it('throws when the native write fails', async () => {
    mockWriteText.mockRejectedValue(new Error('denied'));
    await expect(writeClipboardText('native')).rejects.toThrow('Tauri clipboard writing failed.');
  });

  it('clears through the plugin', async () => {
    mockClear.mockResolvedValue(undefined);
    await expect(clearClipboardText()).resolves.toBeUndefined();
    expect(mockClear).toHaveBeenCalled();
  });

  it('throws when the native clear fails', async () => {
    mockClear.mockRejectedValue(new Error('denied'));
    await expect(clearClipboardText()).rejects.toThrow('Tauri clipboard clearing failed.');
  });

  it('clears a matching sensitive URL through the native path', async () => {
    mockReadText.mockResolvedValue('https://secret.link');
    mockClear.mockResolvedValue(undefined);
    await clearClipboardIfTextMatches('https://secret.link');
    expect(mockClear).toHaveBeenCalled();
  });
});
