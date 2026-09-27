import browser from 'webextension-polyfill';

export async function sendMessageToContent(tabId: number, msg: unknown): Promise<unknown> {
  try {
    return await browser.tabs.sendMessage(tabId, msg);
  } catch {
    return undefined;
  }
}
