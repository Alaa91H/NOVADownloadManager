import { defineBackground } from 'wxt/utils/define-background';
import { bridgeManager } from '../bridge/bridge-manager';
import { SettingsStore } from '../storage/settings-store';
import { MigrationStore } from '../storage/migration-store';
import { registerAlarms, scheduleReconnect } from './alarms';
import { updateBadge } from './badge';
import { Logger } from '../core/logger';
import { registerCommands } from './commands';
import { registerContextMenus } from './context-menus';
import { registerLifecycle } from './lifecycle';
import { registerDownloadInterceptor } from './download-interceptor';
import { registerNetworkObserver } from './network-observer';
import { enforceAggressivePermissions, registerAggressivePermissionRevocationWatcher } from '../profiles/aggressive-permission-enforcer';
import './message-router';

const log = new Logger('background');

export default defineBackground(() => {
  // MV3: event listeners must be registered synchronously in the first turn of
  // the service worker, or the event that woke the worker is dropped. Download
  // takeover and network capture come first — they are the reason the worker
  // gets woken most of the time.
  registerDownloadInterceptor();
  registerNetworkObserver();
  registerLifecycle();
  registerContextMenus();
  registerCommands();
  registerAlarms();
  registerAggressivePermissionRevocationWatcher();
  void boot().catch((error) => log.error('background boot failed', error));
});

async function boot(): Promise<void> {
  await new MigrationStore().migrate();
  await enforceAggressivePermissions('background.boot');
  await bridgeManager.init();
  const settings = await new SettingsStore().get();
  if (settings.enabled && settings.autoConnect) {
    const state = await bridgeManager.autoConnect();
    if (!state.canSend && state.lastError?.retryable && state.retryAfterMs) await scheduleReconnect(state.retryAfterMs);
  }
  await updateBadge(bridgeManager.getState());
}
