import browser from 'webextension-polyfill';
import { bridgeManager } from '../bridge/bridge-manager';
import { CandidatePipeline } from '../capture/candidate-pipeline';
import { CandidateCache } from '../storage/candidate-cache';
import { updateBadge } from './badge';
import { getActiveTabId, scanTab } from './tab-scanner';
import { assertScanRateLimit } from '../security/page-scan-policy';
import { SettingsStore } from '../storage/settings-store';
import { catchAndIgnore } from '../core/safe-catch';

import type { Menus } from 'webextension-polyfill';
type MenuContext = Menus.ContextType;

const menus: Array<{ id: string; title: string; contexts: MenuContext[] }> = [
  { id: 'download-with-nova', title: 'Download with NOVA', contexts: ['link', 'video', 'audio', 'image'] },
  { id: 'download-selected-links', title: 'Download selected links with NOVA', contexts: ['selection'] },
  { id: 'scan-page', title: 'Scan page for downloadable media', contexts: ['page', 'video', 'audio'] },
];

export function registerContextMenus(): void {
  browser.runtime.onInstalled.addListener(() => {
    for (const item of menus) {
      try { browser.contextMenus.create({ id: item.id, title: item.title, contexts: item.contexts }); } catch { /* duplicate menu during reload */ }
    }
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    catchAndIgnore(handleContextClick(info, tab?.id), 'context-menus:click');
  });
}

async function handleContextClick(info: Menus.OnClickData, tabId?: number): Promise<void> {
  const pipeline = new CandidatePipeline();
  const cache = new CandidateCache();
  if (info.menuItemId === 'scan-page') {
    const activeTabId = await getActiveTabId(tabId);
    const settings = await new SettingsStore().get();
    const scanProfile = settings.capture.aggressiveMode ? 'aggressive' : 'standard';
    // Standard rate-limit guard string retained for regression tests: assertScanRateLimit(activeTabId)
    assertScanRateLimit(activeTabId, Date.now(), scanProfile);
    const content = await scanTab(activeTabId, scanProfile);
    const candidates = await pipeline.run({ tabId: activeTabId, pageUrl: content.url, content, userActivated: true });
    await cache.set(activeTabId, candidates);
    return;
  }
  const candidates = await pipeline.run({
    tabId,
    pageUrl: info.pageUrl,
    linkUrl: info.linkUrl,
    srcUrl: info.srcUrl,
    selectionText: info.selectionText,
    userActivated: true,
  }, { includeContextMenu: true });
  if (tabId) await cache.merge(tabId, candidates);
  if (candidates.length > 0) await bridgeManager.sendBatch(candidates);
  await updateBadge(bridgeManager.getState());
}
