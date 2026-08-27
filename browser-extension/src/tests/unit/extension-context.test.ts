import { describe, expect, it } from 'vitest';
import {
  isExtensionContextInvalidated,
  shouldSuppressContentScriptWindowError,
} from '../../content/extension-context-diagnostics';

describe('extension content lifecycle diagnostics', () => {
  it('recognizes an extension context invalidated error case-insensitively', () => {
    expect(isExtensionContextInvalidated(new Error('Extension context invalidated.'))).toBe(true);
    expect(isExtensionContextInvalidated('extension context invalidated')).toBe(true);
  });

  it('suppresses only browser-defined benign lifecycle and resize diagnostics', () => {
    expect(
      shouldSuppressContentScriptWindowError(
        'ResizeObserver loop completed with undelivered notifications.',
        null,
      ),
    ).toBe(true);
    expect(shouldSuppressContentScriptWindowError('', new Error('Extension context invalidated.'))).toBe(true);
  });

  it('keeps unrelated content-script errors visible for diagnosis', () => {
    expect(shouldSuppressContentScriptWindowError('TypeError: failed to parse data', null)).toBe(false);
    expect(isExtensionContextInvalidated(new Error('The message port closed before a response was received.'))).toBe(false);
  });
});
