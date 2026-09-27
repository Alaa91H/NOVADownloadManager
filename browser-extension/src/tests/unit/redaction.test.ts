import { describe, expect, it } from 'vitest';
import { redact, redactHeaders, redactUrl } from '../../security/redaction';

describe('redactUrl', () => {
  it('redacts query strings in URLs', () => {
    expect(redactUrl('https://example.com/path?secret=123&token=abc')).toBe('https://example.com/path?redacted');
  });

  it('preserves URLs without query strings', () => {
    expect(redactUrl('https://example.com/video.mp4')).toBe('https://example.com/video.mp4');
  });

  it('handles empty input', () => {
    expect(redactUrl('')).toBe('');
  });
});

describe('redact', () => {
  it('redacts sensitive key patterns', () => {
    const input = { token: 'abc123', secret: 'xyz', data: 'hello', nested: { apiKey: 'key', auth: 'bearer' } };
    const result = redact(input) as Record<string, unknown>;
    expect(result.token).toBe('[REDACTED]');
    expect(result.secret).toBe('[REDACTED]');
    expect(result.data).toBe('hello');
    expect((result.nested as Record<string, unknown>).apiKey).toBe('[REDACTED]');
    expect((result.nested as Record<string, unknown>).auth).toBe('[REDACTED]');
  });

  it('returns primitives unchanged', () => {
    expect(redact('hello')).toBe('hello');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('redacts deeply nested sensitive values', () => {
    const input = { level1: { level2: { token: 'sneaky' } } };
    const result = redact(input) as Record<string, unknown>;
    const level1 = result.level1 as Record<string, unknown>;
    const level2 = level1.level2 as Record<string, unknown>;
    expect(level2.token).toBe('[REDACTED]');
  });

  it('redacts arrays recursively', () => {
    const input = [{ token: 'abc' }, { data: 'ok' }];
    const result = redact(input) as Array<Record<string, unknown>>;
    expect(result[0]?.token).toBe('[REDACTED]');
    expect(result[1]?.data).toBe('ok');
  });
});

describe('redactHeaders', () => {
  it('redacts authorization and cookie headers', () => {
    const headers = { authorization: 'Bearer abc', cookie: 'session=123', 'content-type': 'text/html' };
    const result = redactHeaders(headers) as Record<string, string>;
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.cookie).toBe('[REDACTED]');
    expect(result['content-type']).toBe('text/html');
  });

  it('redacts all header keys matching SECRET_KEYS (regression)', () => {
    const headers = {
      authorization: 'v1',
      token: 'v2',
      'set-cookie': 'v3',
      pairToken: 'v4',
      bearer: 'v5',
      signature: 'v6',
      sig: 'v7',
      key: 'v8',
      secret: 'v9',
      credential: 'v10',
      password: 'v11',
      session: 'v12',
      jwt: 'v13',
      auth: 'v14',
      'x-api-key': 'v15',
      'x-auth-token': 'v16',
    };
    const result = redactHeaders(headers) as Record<string, string>;
    for (const [_key, value] of Object.entries(result)) {
      expect(value).toBe('[REDACTED]');
    }
  });

  it('preserves non-sensitive headers', () => {
    const headers = {
      'content-type': 'application/json',
      accept: 'text/html',
      'x-request-id': 'abc123',
      'user-agent': 'Mozilla/5.0',
      referer: 'https://example.com',
    };
    const result = redactHeaders(headers) as Record<string, string>;
    for (const [_key, value] of Object.entries(result)) {
      expect(value).not.toBe('[REDACTED]');
    }
  });

  it('handles undefined headers', () => {
    expect(redactHeaders(undefined)).toBeUndefined();
  });
});
