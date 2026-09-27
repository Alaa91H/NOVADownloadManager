import { describe, expect, it } from 'vitest';
import { validateRecipe, validateSelector, validateRecipeBatch } from '../../rules/site-recipe-validator';
import { createDefaultSiteRule } from '../../rules/site-rules';

describe('validateRecipe', () => {
  it('accepts a valid default rule', () => {
    const rule = createDefaultSiteRule('example.com');
    const result = validateRecipe(rule);
    expect(result.ok).toBe(true);
  });

  it('rejects a rule with eval in host field', () => {
    const rule = { ...createDefaultSiteRule('example.com'), host: 'eval(alert(1)).com' };
    const result = validateRecipe(rule);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => /dangerous/i.test(e))).toBe(true);
  });

  it('rejects a rule with javascript: in a pattern', () => {
    const rule = createDefaultSiteRule('example.com');
    const bad = { ...rule, includePatterns: ['javascript:void(0)'] };
    const result = validateRecipe(bad);
    expect(result.ok).toBe(false);
  });

  it('rejects a rule with Function constructor in a pattern', () => {
    const rule = createDefaultSiteRule('example.com');
    const bad = { ...rule, excludePatterns: ['new Function("return 1")'] };
    const result = validateRecipe(bad);
    expect(result.ok).toBe(false);
  });

  it('rejects a rule with a remote URL in a pattern', () => {
    const rule = createDefaultSiteRule('example.com');
    const bad = { ...rule, includePatterns: ['https://evil.com/payload.js'] };
    const result = validateRecipe(bad);
    expect(result.ok).toBe(false);
  });

  it('rejects an object that does not match the SiteRule schema', () => {
    const result = validateRecipe({ host: 'example.com' }); // missing required fields
    expect(result.ok).toBe(false);
  });

  it('accepts valid wildcard patterns', () => {
    const rule = createDefaultSiteRule('*.example.com');
    const result = validateRecipe(rule);
    expect(result.ok).toBe(true);
  });
});

describe('validateSelector', () => {
  it('accepts a safe CSS selector', () => {
    expect(validateSelector('video[src]').length).toBe(0);
    expect(validateSelector('a[href$=".mp4"]').length).toBe(0);
  });

  it('rejects a selector with javascript:', () => {
    expect(validateSelector('a[href="javascript:void(0)"]').length).toBeGreaterThan(0);
  });

  it('rejects a selector with an event handler attribute', () => {
    expect(validateSelector('[onerror="alert(1)"]').length).toBeGreaterThan(0);
  });

  it('rejects a selector with CSS expression()', () => {
    expect(validateSelector('div { width: expression(alert(1)) }').length).toBeGreaterThan(0);
  });
});

describe('validateRecipeBatch', () => {
  it('separates valid from invalid recipes', () => {
    const good = createDefaultSiteRule('good.com');
    const bad = { ...createDefaultSiteRule('bad.com'), host: 'eval(1).com' };
    const { accepted, rejected } = validateRecipeBatch([good, bad, 'not-an-object']);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(2);
  });

  it('returns empty arrays for empty input', () => {
    const { accepted, rejected } = validateRecipeBatch([]);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(0);
  });
});
