import { vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Match media
Object.defineProperty(window, 'matchMedia', {
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ResizeObserver
class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
window.ResizeObserver = ResizeObserverMock;

// IntersectionObserver
class IntersectionObserverMock {
  readonly root: Element | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: ReadonlyArray<number> = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn();
}
window.IntersectionObserver = IntersectionObserverMock;

// scrollTo
window.scrollTo = vi.fn();

// Notification
Object.defineProperty(window, 'Notification', {
  value: vi.fn().mockImplementation(() => ({})),
  writable: true,
});

// __TAURI__
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: vi.fn(),
};
