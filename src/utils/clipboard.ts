import { isTauri } from '@tauri-apps/api/core';

function runningInTauri(): boolean {
  try {
    return isTauri();
  } catch {
    return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
  }
}

export async function readClipboardText(): Promise<string> {
  let nativeError: unknown;

  if (runningInTauri()) {
    try {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
      return await readText();
    } catch (error) {
      nativeError = error;
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
    return await navigator.clipboard.readText();
  }

  throw nativeError instanceof Error
    ? nativeError
    : new Error('Clipboard reading is not available.');
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
