import { isTauri } from '@tauri-apps/api/core';

function runningInTauri(): boolean {
  try {
    return isTauri();
  } catch {
    return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
  }
}

export async function readClipboardText(): Promise<string> {
  if (runningInTauri()) {
    // Native read only. Never fall back to navigator.clipboard inside the
    // webview: it triggers the browser permission prompt
    // ("http://tauri.localhost wants to see text and images...").
    try {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
      return await readText();
    } catch {
      // The clipboard is empty or holds non-text content (e.g. an image).
      return '';
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
    return await navigator.clipboard.readText();
  }

  throw new Error('Clipboard reading is not available.');
}

export async function writeClipboardText(text: string): Promise<void> {
  if (runningInTauri()) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  throw new Error('Clipboard writing is not available.');
}

export async function clearClipboardText(): Promise<void> {
  if (runningInTauri()) {
    const { clear } = await import('@tauri-apps/plugin-clipboard-manager');
    await clear();
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText('');
  }
}

export async function clearClipboardIfTextMatches(text: string): Promise<void> {
  const sensitiveText = text.trim();
  if (!sensitiveText) return;

  try {
    const currentText = (await readClipboardText()).trim();
    if (currentText === sensitiveText || currentText.includes(sensitiveText)) {
      await clearClipboardText();
    }
  } catch {
    // Clipboard cleanup is best-effort and should never block a download action.
  }
}

export function extractFirstHttpUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"'`]+/i);
  return match?.[0].replace(/[),.;\]]+$/, '') || null;
}
