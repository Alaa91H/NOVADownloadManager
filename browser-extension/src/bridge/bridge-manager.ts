import browser from 'webextension-polyfill';
import { z } from 'zod';
import { BridgeState, initialBridgeState } from '../core/app-state';
import { BridgeGateway } from '../core/bridge-gateway';
import { Logger } from '../core/logger';
import { SingleFlight } from '../core/single-flight';
import { isAuthError, toNovaExtensionError } from '../core/error-classification';
import { bridgeError } from '../contracts/errors.schema';
import {
  AddBatchRequestSchema,
  AddTaskRequestSchema,
  AddTaskResponseSchema,
  AuthCheckResponseSchema,
  PingResponseSchema,
  TaskCommandResponseSchema,
  TaskListResponseSchema,
  StreamResolveRequestSchema,
  StreamResolveResponseSchema,
  StreamAddRequestSchema,
  YtdlpProbeResponseSchema,
  AnalyzeResponseSchema,
  NOVA_PROTOCOL_VERSION,
  type StreamResolveResponse,
  type StreamManifestCandidate,
  type AddTaskResponse,
  type YtdlpProbeResponse,
  type AnalyzeResponse,
} from '../contracts/nova.protocol.v4';
import { Candidate } from '../contracts/candidate.schema';
import { NovaEvent } from '../contracts/events.schema';
import { OutboxService } from '../outbox/outbox-service';
import { OutboxStore } from '../outbox/outbox-store';
import { OutboxRetryWorker } from '../outbox/retry-worker';
import { assertCandidateHandoffAllowed } from '../security/handoff-policy';
import { assertHandoffPayloadBudget } from '../security/payload-budget';
import { assertTaskIdSafe } from '../security/task-command-policy';
import { StateStore } from '../storage/state-store';
import { TransportManager } from '../transport/transport-manager';
import { AuthManager } from './auth-manager';
import { CapabilitySync } from './capability-sync';
import { HealthMonitor } from './health-monitor';
import { PairingManager } from './pairing-manager';
import { ReconnectPolicy } from './reconnect-policy';

const EVENT_RESUBSCRIBE_DELAY_MS = 5_000;

export class BridgeManager implements BridgeGateway {
  private readonly log = new Logger('bridge');
  private state: BridgeState = initialBridgeState;
  private readonly tm = new TransportManager();
  private readonly auth = new AuthManager();
  private readonly pairing = new PairingManager(this.tm);
  private readonly caps = new CapabilitySync(this.tm);
  private readonly retry = new ReconnectPolicy();
  private readonly health = new HealthMonitor();
  private readonly outboxStore = new OutboxStore();
  private readonly outbox = new OutboxService(this.outboxStore);
  private readonly connectFlight = new SingleFlight<BridgeState>();
  private readonly outboxFlight = new SingleFlight<void>();
  private eventResubscribeTimer?: number;

  constructor(private readonly stateStore = new StateStore()) {}

  async init(): Promise<void> {
    this.state = await this.stateStore.getBridgeState();
    await this.setState({ status: this.state.status === 'connected' ? 'booting' : this.state.status, canSend: false });
  }

  getState(): BridgeState {
    return this.state;
  }

  private async setState(patch: Partial<BridgeState>): Promise<void> {
    this.state = { ...this.state, ...patch };
    await this.stateStore.setBridgeState(this.state);
  }

  async autoConnect(): Promise<BridgeState> {
    return this.connectFlight.run(() => this.autoConnectInternal());
  }

  private async autoConnectInternal(): Promise<BridgeState> {
    await this.setState({ status: 'discovering', canSend: false, lastError: undefined });
    try {
      const discovered = await this.discover();
      if (!discovered.http) {
        await this.setState({
          status: discovered.native ? 'degraded' : 'offline',
          transport: discovered.transport,
          canSend: false,
          lastError: bridgeError('DAEMON_UNAVAILABLE', 'NOVA service is not reachable on loopback.', true, 'Start NOVA or run Repair.'),
        });
        return this.state;
      }

      const ping = await this.ping();
      if (!ping.browserIntegrationEnabled) {
        await this.setState({
          status: 'integrationDisabled',
          canSend: false,
          lastError: bridgeError('BROWSER_INTEGRATION_DISABLED', 'Browser integration is disabled in NOVA.', false),
        });
        return this.state;
      }

      if (ping.protocolVersion < ping.minimumSupportedProtocolVersion || ping.minimumSupportedProtocolVersion > NOVA_PROTOCOL_VERSION) {
        await this.setState({
          status: 'protocolMismatch',
          protocolVersion: ping.protocolVersion,
          minimumSupportedProtocolVersion: ping.minimumSupportedProtocolVersion,
          canSend: false,
          lastError: bridgeError('PROTOCOL_MISMATCH', 'NOVA protocol is not compatible with this extension.', false),
        });
        return this.state;
      }

      let token = await this.auth.getToken();
      if (token) {
        try {
          await this.authCheck(token);
        } catch (error) {
          this.log.warn('stored token rejected; clearing token', error);
          await this.auth.clear();
          token = undefined;
        }
      }

      if (!token) {
        await this.setState({ status: 'pairing' });
        const pair = await this.pair();
        token = pair.pairToken;
        await this.auth.setToken(token, pair.ttlSeconds);
      }

      await this.setState({ status: 'capabilitySyncing' });
      const capabilities = await this.refreshCapabilities(token);
      this.retry.reset();
      await this.setState({
        status: 'connected',
        canSend: true,
        transport: discovered.transport ?? 'http',
        protocolVersion: ping.protocolVersion,
        minimumSupportedProtocolVersion: ping.minimumSupportedProtocolVersion,
        capabilities,
        lastConnectedAt: new Date().toISOString(),
        lastError: undefined,
        retryAfterMs: undefined,
      });
      this.subscribeEvents();
      return this.state;
    } catch (error) {
      const normalized = toNovaExtensionError(error, 'NETWORK_ERROR');
      const retryAfterMs = normalized.retryable ? this.retry.next() : undefined;
      await this.setState({
        status: normalized.code === 'TOKEN_EXPIRED' ? 'tokenExpired' : 'offline',
        canSend: false,
        lastError: bridgeError(normalized.code, normalized.message, normalized.retryable, normalized.repairHint ?? 'Retry connection or open diagnostics.'),
        retryAfterMs,
      });
      return this.state;
    }
  }

  async discover(): Promise<{ native: boolean; http: boolean; transport: 'native' | 'http' | 'mixed' | null }> {
    await this.setState({ status: 'nativeChecking' });
    const result = await this.tm.discover();
    await this.setState({ transport: result.transport });
    return result;
  }

  tryNative(): Promise<boolean> {
    return this.tm.native.isAvailable();
  }

  tryLoopback(): Promise<boolean> {
    return this.tm.http.isAvailable();
  }

  async ping() {
    await this.setState({ status: 'daemonChecking' });
    return this.tm.requestHttp('/v1/ping', undefined, PingResponseSchema, undefined, 'GET');
  }

  pair() {
    return this.pairing.pair(browser.runtime.getURL(''));
  }

  async authCheck(token: string) {
    await this.setState({ status: 'authChecking' });
    return this.tm.requestHttp('/v1/auth/check', {}, AuthCheckResponseSchema, token, 'POST');
  }

  async refreshCapabilities(token?: string) {
    const resolvedToken = token ?? await this.auth.getToken();
    if (!resolvedToken) throw new Error('missing token');
    return this.caps.refresh(resolvedToken);
  }

  subscribeEvents(): void {
    if (this.eventResubscribeTimer !== undefined) {
      clearTimeout(this.eventResubscribeTimer);
      this.eventResubscribeTimer = undefined;
    }
    this.tm.closeEvents();
    this.health.reset();
    // SSE is the active event transport. WebSocketTransport is a complete, tested
    // adapter held in reserve: it is wired through TransportManager.closeEvents()
    // and only activates when the desktop advertises the 'events.websocket'
    // capability with a defined ws endpoint and auth scheme.
    const tokenPromise = this.auth.getToken();
    void tokenPromise.then((token) => {
      if (!token || !this.caps.registry.has('events.sse')) return;
      void this.tm.sse.connectFirst([this.tm.http.url('/v1/events')], token, {
        onOpen: () => this.health.mark(),
        onEvent: (event: NovaEvent) => this.handleEvent(event),
        onError: (error: unknown) => {
          this.log.warn('SSE disconnected', error);
          this.scheduleEventResubscribe();
        },
      });
    });
  }

  // A silent event-stream drop leaves canSend=true but stops heartbeats. When the
  // stream errors while we still believe we are connected, re-subscribe once after a
  // short delay (guarded so transient errors cannot spin into a reconnect loop).
  private scheduleEventResubscribe(): void {
    if (this.eventResubscribeTimer !== undefined) return;
    if (!this.state.canSend || !this.health.isStale()) return;
    this.eventResubscribeTimer = setTimeout(() => {
      this.eventResubscribeTimer = undefined;
      if (this.state.canSend) this.subscribeEvents();
    }, EVENT_RESUBSCRIBE_DELAY_MS) as unknown as number;
  }

  private handleEvent(event: NovaEvent): void {
    if (event.type === 'heartbeat' || event.type === 'connected') this.health.mark();
  }

  async sendCandidate(candidate: Candidate) {
    const job = await this.outbox.enqueueCandidate(candidate);
    await this.runOutboxOnce();
    return (await this.outboxStore.get(job.id)) ?? job;
  }

  async sendBatch(candidates: Candidate[]) {
    const job = await this.outbox.enqueueBatch(candidates);
    await this.runOutboxOnce();
    return (await this.outboxStore.get(job.id)) ?? job;
  }

  // --- Stream resolve / add (Phase: quality selector) ---
  // The extension asks NOVA Desktop to resolve a manifest into its concrete
  // qualities. NOVA owns the actual parsing/downloading; the extension only
  // surfaces the choices to the user.
  listCapabilities(): string[] {
    return this.caps.registry.list();
  }

  async resolveStream(request: { manifestType: 'hls' | 'dash'; url: string; pageUrl?: string }): Promise<StreamResolveResponse> {
    await this.ensureReadyToSend();
    const cap = request.manifestType === 'hls' ? 'stream.hls.resolve' : 'stream.dash.resolve';
    this.caps.registry.require(cap);
    const payload = StreamResolveRequestSchema.parse(request);
    return this.authenticatedHttp('/v1/stream/resolve', payload, StreamResolveResponseSchema, 'POST');
  }

  async addStream(manifest: StreamManifestCandidate, selectedQuality: StreamResolveResponse['qualities'][number] | undefined, idempotencyKey: string): Promise<AddTaskResponse> {
    await this.ensureReadyToSend();
    const cap = manifest.manifestType === 'hls' ? 'candidate.hls' : 'candidate.dash';
    this.caps.registry.require(cap);
    const request = StreamAddRequestSchema.parse({ idempotencyKey, manifest, selectedQuality, source: 'nova-extension' });
    return this.authenticatedHttp('/v1/stream/add', request, AddTaskResponseSchema, 'POST');
  }

  async probeYtdlp(url: string): Promise<YtdlpProbeResponse> {
    await this.ensureReadyToSend();
    return this.authenticatedHttp<YtdlpProbeResponse>(
      `/api/ytdlp/probe?url=${encodeURIComponent(url)}`,
      undefined,
      YtdlpProbeResponseSchema,
      'GET',
    );
  }

  async analyzeMedia(url: string, context?: { pageUrl?: string; referrer?: string; title?: string; mediaType?: string }): Promise<AnalyzeResponse> {
    await this.ensureReadyToSend();
    this.caps.registry.require('media.analyze');
    const payload = { url, context: context ?? {} };
    return this.authenticatedHttp('/v1/analyze', payload, AnalyzeResponseSchema, 'POST');
  }

  async sendCandidateNow(candidate: Candidate, idempotencyKey: string) {
    await this.ensureReadyToSend();
    assertHandoffPayloadBudget([candidate]);
    this.requireCandidateCapabilities(candidate);
    this.caps.registry.require('task.add');
    const request = AddTaskRequestSchema.parse({ idempotencyKey, candidate, source: 'nova-extension' });
    return this.authenticatedHttp('/v1/add', request, AddTaskResponseSchema, 'POST');
  }

  async sendBatchNow(candidates: Candidate[], idempotencyKey: string) {
    await this.ensureReadyToSend();
    assertHandoffPayloadBudget(candidates);
    this.caps.registry.require('task.addBatch');
    for (const candidate of candidates) this.requireCandidateCapabilities(candidate);
    const request = AddBatchRequestSchema.parse({ idempotencyKey, candidates, source: 'nova-extension' });
    return this.authenticatedHttp('/captures', request, AddTaskResponseSchema, 'POST');
  }


  private requireCandidateCapabilities(candidate: Candidate): void {
    assertCandidateHandoffAllowed(candidate);
    if (candidate.mediaType === 'torrent') {
      this.caps.registry.require('candidate.torrent');
      return;
    }
    if (candidate.mediaType === 'magnet') {
      this.caps.registry.require('candidate.magnet');
      return;
    }
    if (candidate.source === 'hls-manifest') {
      this.caps.registry.require('candidate.hls');
      return;
    }
    if (candidate.source === 'dash-manifest') {
      this.caps.registry.require('candidate.dash');
      return;
    }
    if (candidate.mediaType === 'manifest') {
      if (!this.caps.registry.has('candidate.hls') && !this.caps.registry.has('candidate.dash')) {
        this.caps.registry.require('candidate.hls');
      }
      return;
    }
    this.caps.registry.require('candidate.directUrl');
    const protocol = this.protocolForCandidate(candidate);
    const advertised = new Set((this.state.capabilities?.directProtocols ?? []).map((item) => item.toLowerCase()));
    if (protocol && advertised.size > 0 && !advertised.has(protocol)) {
      throw new Error(`Desktop linked libcurl does not advertise protocol: ${protocol}`);
    }
  }

  private protocolForCandidate(candidate: Candidate): string | undefined {
    try {
      return new URL(candidate.finalUrl ?? candidate.url).protocol.replace(/:$/, '').toLowerCase();
    } catch {
      return undefined;
    }
  }

  private async authenticatedHttp<T>(route: string, payload: unknown, schema: z.ZodType<T>, method: 'GET' | 'POST' = 'POST'): Promise<T> {
    let token = await this.auth.getToken();
    if (!token) {
      await this.autoConnect();
      token = await this.auth.getToken();
    }
    if (!token) throw new Error('missing token');

    try {
      return await this.tm.requestHttp(route, payload, schema, token, method);
    } catch (error) {
      if (!isAuthError(error)) throw error;
      this.log.warn('auth token expired or invalid; repairing pairing before retry');
      await this.auth.clear();
      const state = await this.autoConnect();
      const refreshedToken = await this.auth.getToken();
      if (!state.canSend || !refreshedToken) throw error;
      return this.tm.requestHttp(route, payload, schema, refreshedToken, method);
    }
  }


  private async ensureReadyToSend(): Promise<void> {
    if (this.state.canSend && this.state.status === 'connected') return;
    if (this.state.status === 'degraded' && this.state.canSend) return;
    const state = await this.autoConnect();
    if (!state.canSend) {
      throw new Error(state.lastError?.message ?? 'NOVA bridge is not ready to send tasks.');
    }
  }

  async pauseTask(taskId: string) {
    const safeTaskId = assertTaskIdSafe(taskId);
    await this.ensureReadyToSend();
    this.caps.registry.require('task.pause');
    return this.taskCommand('task.pause', safeTaskId, ['/v1/task/pause', `/v1/tasks/${encodeURIComponent(safeTaskId)}/pause`]);
  }

  async resumeTask(taskId: string) {
    const safeTaskId = assertTaskIdSafe(taskId);
    await this.ensureReadyToSend();
    this.caps.registry.require('task.resume');
    return this.taskCommand('task.resume', safeTaskId, ['/v1/task/resume', `/v1/tasks/${encodeURIComponent(safeTaskId)}/resume`]);
  }

  async cancelTask(taskId: string) {
    const safeTaskId = assertTaskIdSafe(taskId);
    await this.ensureReadyToSend();
    this.caps.registry.require('task.cancel');
    return this.taskCommand('task.cancel', safeTaskId, ['/v1/task/cancel', `/v1/tasks/${encodeURIComponent(safeTaskId)}/cancel`]);
  }

  private async taskCommand(method: string, taskId: string, routes: string[]) {
    try {
      return await this.tm.requestNative(method, { taskId }, TaskCommandResponseSchema);
    } catch (nativeError) {
      this.log.warn('native task command failed; trying loopback', nativeError);
      let lastError: unknown = nativeError;
      for (const route of routes) {
        try {
          return await this.authenticatedHttp(route, { taskId }, TaskCommandResponseSchema, 'POST');
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error('task command failed');
    }
  }

  async listTasks() {
    if (!this.state.canSend) return [];
    try {
      const result = await this.tm.requestNative('task.list', {}, TaskListResponseSchema.catch({ ok: true, tasks: [] }));
      return result.tasks;
    } catch {
      const result = await this.authenticatedHttp('/v1/tasks', undefined, TaskListResponseSchema.catch({ ok: true, tasks: [] }), 'GET');
      return result.tasks;
    }
  }

  async getDiagnostics() {
    const [outbox, nativeAvailable, httpAvailable, auth] = await Promise.all([this.outboxStore.counts(), this.tryNative(), this.tryLoopback(), this.auth.tokenStatus()]);
    return z.object({
      bridge: z.unknown(),
      outbox: z.unknown(),
      nativeAvailable: z.boolean(),
      daemonReachable: z.boolean(),
      auth: z.unknown(),
      generatedAt: z.string(),
    }).parse({ bridge: this.state, outbox, nativeAvailable, daemonReachable: httpAvailable, auth, generatedAt: new Date().toISOString() });
  }

  async runOutboxOnce(): Promise<void> {
    await this.outboxFlight.run(async () => {
      const worker = new OutboxRetryWorker(this.outboxStore, this);
      await worker.runOnce();
    });
  }

  async repair(): Promise<BridgeState> {
    await this.auth.clear();
    this.tm.closeEvents();
    return this.autoConnect();
  }

  async reconnect(): Promise<BridgeState> {
    await this.setState({ status: 'reconnecting' });
    return this.autoConnect();
  }

  async wakeUpDesktop(): Promise<BridgeState> {
    await this.setState({ status: 'booting', canSend: false, lastError: undefined });
    try {
      const nativeAvailable = await this.tm.native.isAvailable();
      if (!nativeAvailable) {
        await this.setState({
          status: 'offline',
          canSend: false,
          lastError: bridgeError('DAEMON_UNAVAILABLE', 'Desktop application is not installed or not responding.', false, 'Install the desktop application and ensure it is running.'),
        });
        return this.state;
      }
      // No fixed sleep: discover() now adaptively polls until the freshly
      // launched daemon binds its port, returning as soon as it answers.
      return this.autoConnect();
    } catch {
      await this.setState({
        status: 'offline',
        canSend: false,
        lastError: bridgeError('DAEMON_UNAVAILABLE', 'Desktop application is not installed or not responding.', false, 'Install the desktop application and ensure it is running.'),
      });
      return this.state;
    }
  }

  async shutdown(): Promise<void> {
    if (this.eventResubscribeTimer !== undefined) {
      clearTimeout(this.eventResubscribeTimer);
      this.eventResubscribeTimer = undefined;
    }
    this.tm.closeEvents();
    this.log.info('shutdown');
  }
}

export const bridgeManager = new BridgeManager();
