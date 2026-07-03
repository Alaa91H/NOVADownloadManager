import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { HttpTransport } from '../../transport/http-transport';
import { AddTaskResponseSchema, AuthCheckResponseSchema, PairResponseSchema, PingResponseSchema } from '../../contracts/adm.protocol.v4';

const processes: ChildProcess[] = [];

async function waitForPing(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v1/ping`);
      if (response.ok) return;
    } catch {
      // retry until daemon starts
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`fake ADM did not start at ${baseUrl}`);
}

async function startFakeAdm(scenario = 'success'): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  const port = 59000 + Math.floor(Math.random() * 3000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'fake-adm-daemon/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, ADM_FAKE_PORT: String(port), ADM_FAKE_SCENARIO: scenario },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.push(child);
  await waitForPing(baseUrl);
  return {
    baseUrl,
    stop: async () => {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

function redirectOfficialLoopbackFetch(toBaseUrl: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
    if (rawUrl.startsWith('http://127.0.0.1:3199/')) {
      const redirected = rawUrl.replace('http://127.0.0.1:3199', toBaseUrl);
      if (input instanceof Request) return originalFetch(new Request(redirected, input), init);
      return originalFetch(redirected, init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

afterEach(async () => {
  await Promise.all(processes.splice(0).map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  })));
});

describe('fake ADM daemon integration', () => {
  it('supports ping, pair, auth-check, and add task over loopback', async () => {
    const daemon = await startFakeAdm();
    const restoreFetch = redirectOfficialLoopbackFetch(daemon.baseUrl);
    try {
      const http = new HttpTransport();
      const ping = await http.request('/v1/ping', undefined, PingResponseSchema, { method: 'GET' });
      expect(ping.protocolVersion).toBe(4);

      const pair = await http.request('/v1/pair/auto', { clientId: 'test' }, PairResponseSchema, { method: 'POST' });
      expect(pair.pairToken).toHaveLength(32);

      const auth = await http.request('/v1/auth/check', {}, AuthCheckResponseSchema, { method: 'POST', token: pair.pairToken });
      expect(auth.ok).toBe(true);

      const added = await http.request('/v1/add', {
        idempotencyKey: 'integration-test-key-0001',
        source: 'adm-extension',
        candidate: {
          id: 'candidate-1',
          url: 'https://example.com/file.zip',
          source: 'dom',
          mediaType: 'archive',
          confidence: 90,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }, AddTaskResponseSchema, { method: 'POST', token: pair.pairToken });
      expect(added.accepted).toBe(true);
    } finally {
      restoreFetch();
      await daemon.stop();
    }
  }, 20_000);
});
