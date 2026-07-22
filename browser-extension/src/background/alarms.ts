import browser from 'webextension-polyfill';
import { bridgeManager } from '../bridge/bridge-manager';
import { updateBadge } from './badge';

const OUTBOX_RETRY_ALARM = 'nova.outbox.retry';
const RECONNECT_ALARM = 'nova.reconnect';

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
  if (state.canSend) {
    // Connected: cancel any pending backstop alarm so it cannot fire a
    // redundant reconnect later.
    await browser.alarms.clear(RECONNECT_ALARM).catch(() => false);
    return;
  }
  if (state.lastError?.retryable && state.retryAfterMs) {
    await scheduleReconnect(state.retryAfterMs);
  }
}

let fastRetryTimer: ReturnType<typeof setTimeout> | undefined;

export async function scheduleReconnect(delayMs: number): Promise<void> {
  // Chrome MV3 clamps alarm firings to >= ~30s on stable channels, so a
  // 2-5s reconnect intent would otherwise become a 30s+ wait. While the
  // service worker is alive, setTimeout delivers the retry on time; the
  // alarm remains as the backstop for when the worker gets suspended.
  if (fastRetryTimer !== undefined) {
    clearTimeout(fastRetryTimer);
  }
  fastRetryTimer = setTimeout(() => {
    fastRetryTimer = undefined;
    void reconnectAndMaybeReschedule();
  }, delayMs);
  await browser.alarms.create(RECONNECT_ALARM, { when: Date.now() + delayMs });
}
