import browser from 'webextension-polyfill';
import { bridgeManager } from '../bridge/bridge-manager';
import { SettingsStore } from '../storage/settings-store';
import { MigrationStore } from '../storage/migration-store';
import { updateBadge } from './badge';
import { Logger } from '../core/logger';
import { scheduleReconnect } from './alarms';
import { enforceAggressivePermissions } from '../profiles/aggressive-permission-enforcer';

const log = new Logger('lifecycle');

export function registerLifecycle(): void {
  browser.runtime.onStartup.addListener(() => {
    void maybeAutoConnect().catch((error) => log.error('lifecycle auto-connect failed', error));
  });
  browser.runtime.onInstalled.addListener(() => {
    void maybeAutoConnect().catch((error) => log.error('lifecycle auto-connect failed', error));
  });
}

async function maybeAutoConnect(): Promise<void> {
  await new MigrationStore().migrate();
  await enforceAggressivePermissions('lifecycle.auto-connect');
  const settings = await new SettingsStore().get();
  if (!settings.enabled || !settings.autoConnect) {
    await updateBadge(bridgeManager.getState());
    return;
  }
  const state = await bridgeManager.autoConnect();
  await updateBadge(state);
  if (!state.canSend && state.lastError?.retryable && state.retryAfterMs) await scheduleReconnect(state.retryAfterMs);
}
