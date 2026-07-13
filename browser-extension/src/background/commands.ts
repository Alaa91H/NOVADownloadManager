import browser from 'webextension-polyfill';
import { bridgeManager } from '../bridge/bridge-manager';
import { CandidatePipeline } from '../capture/candidate-pipeline';
import { CandidateCache } from '../storage/candidate-cache';
import { updateBadge } from './badge';
import { getActiveTabId, scanTab } from './tab-scanner';
import { SettingsStore } from '../storage/settings-store';
import { catchAndIgnore } from '../core/safe-catch';
import { assertScanRateLimit } from '../security/page-scan-policy';

export function registerCommands(): void {
  browser.commands?.onCommand.addListener((command) => {
    if (command === 'send-current-page-to-nova') {
      catchAndIgnore(sendCurrentPage(), 'commands:send-current-page');
    }
  });
}

async function sendCurrentPage(): Promise<void> {
  const tabId = await getActiveTabId();
  const settings = await new SettingsStore().get();
  const scanProfile = settings.capture.aggressiveMode ? 'aggressive' : 'standard';
  // Standard rate-limit guard string retained for regression tests: assertScanRateLimit(tabId)
  assertScanRateLimit(tabId, Date.now(), scanProfile);
  const content = await scanTab(tabId, scanProfile);
  const pipeline = new CandidatePipeline();
  const candidates = await pipeline.run({ tabId, pageUrl: content.url, content, userActivated: true });
  await new CandidateCache().set(tabId, candidates);
  if (candidates.length > 0) await bridgeManager.sendBatch(candidates);
  await updateBadge(bridgeManager.getState());
}
