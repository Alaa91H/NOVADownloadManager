import browser from 'webextension-polyfill';
import { bridgeManager } from '../bridge/bridge-manager';
import { updateBadge } from './badge';

const OUTBOX_RETRY_ALARM = 'adm.outbox.retry';
const RECONNECT_ALARM = 'adm.reconnect';

export function registerAlarms(): void {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === OUTBOX_RETRY_ALARM) void bridgeManager.runOutboxOnce();
    if (alarm.name === RECONNECT_ALARM) void reconnectAndMaybeReschedule();
  });
  void browser.alarms.create(OUTBOX_RETRY_ALARM, { periodInMinutes: 1 });
}

async function reconnectAndMaybeReschedule(): Promise<void> {
  const state = await bridgeManager.reconnect();
  await updateBadge(state);
  if (!state.canSend && state.lastError?.retryable && state.retryAfterMs) {
    await scheduleReconnect(state.retryAfterMs);
  }
}

export async function scheduleReconnect(delayMs: number): Promise<void> {
  await browser.alarms.create(RECONNECT_ALARM, { when: Date.now() + delayMs });
}
