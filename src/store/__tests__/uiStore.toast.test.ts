import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { uiStore } from '../../store/uiStore';

describe('uiStore toast lifecycle', () => {
  beforeEach(() => {
    // Ensure notifications are enabled
    localStorage.removeItem('nova_notifications_muted');
  });

  afterEach(() => {
    // Clear remaining toasts
    uiStore.getState().removeToast = uiStore.getState().removeToast;
  });

  it('adds and auto-removes a toast after timeout', () => {
    vi.useFakeTimers();
    const initial = uiStore.getState().toasts.length;
    uiStore.getState().addToast('info', 'T', 'M');
    expect(uiStore.getState().toasts.length).toBe(initial + 1);
    // advance timers past the auto-remove (4500ms default)
    vi.advanceTimersByTime(5000);
    expect(uiStore.getState().toasts.length).toBe(initial);
    vi.useRealTimers();
  });
});
