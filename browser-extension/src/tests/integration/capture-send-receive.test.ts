import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { DomLinkCapturePlugin } from '../../capture/dom-capture';
import { MetadataEnricher } from '../../pipeline/metadata-enricher';
import { HttpTransport } from '../../transport/http-transport';
import {
  AddTaskRequestSchema,
  AddTaskResponseSchema,
  AuthCheckResponseSchema,
  PairResponseSchema,
} from '../../contracts/nova.protocol.v4';

// End-to-end of the real flow the extension performs: capture a candidate from a
// page, enrich/score it, then hand it to the daemon over loopback â€” and prove the
// daemon actually received that exact candidate (not just that the call returned ok).

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
  throw new Error(`fake NOVA did not start at ${baseUrl}`);
}

async function startFakeNova(scenario = 'success'): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  const port = 59000 + Math.floor(Math.random() * 3000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'fake-nova-daemon/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, NOVA_FAKE_PORT: String(port), NOVA_FAKE_SCENARIO: scenario },
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

describe('capture -> send -> receive', () => {
  it('captures a download link from a page and the daemon receives that exact candidate', async () => {
    // 1. Capture: a realistic page with an explicit download link.
    const pageUrl = 'https://files.example.com/library';
    const targetUrl = 'https://cdn.example.com/videos/release-trailer.mp4';
    const html = `<!doctype html><html><body>
      <a download="release-trailer.mp4" href="${targetUrl}">Download trailer</a>
      <a href="/about">About</a>
    </body></html>`;

    const captured = await new DomLinkCapturePlugin().capture({ html, pageUrl });
    const enricher = new MetadataEnricher();
    const candidates = captured.map((candidate) => enricher.enrich(candidate));

    // The real pipeline must surface the media file and classify/score it.
    const candidate = candidates.find((item) => item.url === targetUrl);
    expect(candidate, 'expected the .mp4 download link to be captured').toBeDefined();
    expect(candidate!.mediaType).toBe('video');
    expect(candidate!.filename).toBe('release-trailer.mp4');
    expect(candidate!.confidence).toBeGreaterThan(0);

    // 2. Send: over the same loopback contract the extension uses.
    const daemon = await startFakeNova();
    const restoreFetch = redirectOfficialLoopbackFetch(daemon.baseUrl);
    try {
      const http = new HttpTransport();
      const pair = await http.request('/v1/pair/auto', { clientId: 'capture-test' }, PairResponseSchema, { method: 'POST' });
      const auth = await http.request('/v1/auth/check', {}, AuthCheckResponseSchema, { method: 'POST', token: pair.pairToken });
      expect(auth.ok).toBe(true);

      const request = AddTaskRequestSchema.parse({
        idempotencyKey: 'capture-send-receive-0001',
        source: 'nova-extension',
        candidate: candidate!,
      });
      const added = await http.request('/v1/add', request, AddTaskResponseSchema, { method: 'POST', token: pair.pairToken });
      expect(added.accepted).toBe(true);

      // 3. Receive: the daemon recorded the exact candidate we captured.
      const ledger = await fetch(`${daemon.baseUrl}/v1/_debug/received`).then((response) => response.json()) as {
        count: number;
        received: Array<{ body: { candidate?: { url?: string }; source?: string } }>;
      };
      expect(ledger.count).toBe(1);
      expect(ledger.received[0]!.body.source).toBe('nova-extension');
      expect(ledger.received[0]!.body.candidate?.url).toBe(targetUrl);
    } finally {
      restoreFetch();
      await daemon.stop();
    }
  }, 20_000);

  it('captures a magnet link and classifies it before sending', async () => {
    const magnet = 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=ubuntu.iso';
    const html = `<a href="${magnet}">Magnet</a>`;
    const captured = await new DomLinkCapturePlugin().capture({ html, pageUrl: 'https://tracker.example.org' });
    const enriched = captured.map((candidate) => new MetadataEnricher().enrich(candidate));

    const candidate = enriched.find((item) => item.url.startsWith('magnet:'));
    expect(candidate, 'expected the magnet link to be captured').toBeDefined();
    expect(candidate!.mediaType).toBe('magnet');
  });
});
