import browser from 'webextension-polyfill';
import { BridgeState } from '../core/app-state';
import { SettingsStore } from '../storage/settings-store';

export async function updateBadge(state: BridgeState): Promise<void> {
  const settings = await new SettingsStore().get();
  const text = settings.showBadge
    ? state.status === 'connected'
      ? 'ON'
      : state.status === 'degraded'
        ? 'DG'
        : state.status === 'reconnecting'
          ? '...'
          : ''
    : '';
  await browser.action.setBadgeText({ text });
  await browser.action.setTitle({ title: `NOVA Extension: ${state.status}` });
}
