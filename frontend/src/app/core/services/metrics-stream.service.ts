import { DestroyRef, effect, Injectable, computed, inject, signal, untracked } from '@angular/core';
import { Microservice, SortColumn, SortDirection } from '../models/service.model';
import { ConnectionStatus, TransportType } from '../models/connection.model';
import { AuthService } from './auth.service';
import { ApiClientService } from './api-client.service';
import { sseUrl, webSocketUrl } from './api-config';
import { environment } from '../../../environments/environment';

const isTestEnv = typeof process !== 'undefined' &&
  (Boolean(process.env['VITEST']) || process.env['NODE_ENV'] === 'test');
const CONNECTION_TIMEOUT_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const HIGHER_PRIORITY_RETRY_MS = 30_000;
const POLLING_INTERVAL_MS = 2000;
const SSE_STABLE_CONNECTION_MS = 30_000;
const isDevelopment = !environment.production;

interface StreamEnvelope {
  type?: unknown;
  offset?: unknown;
  eventId?: unknown;
  updatedServices?: unknown;
  services?: unknown;
  events?: unknown;
  snapshot?: unknown;
  replayFrom?: unknown;
  sequences?: unknown;
  sequence?: unknown;
  serviceId?: unknown;
}

interface SequencedMetricEvent {
  offset: number;
  serviceId: string;
  sequence: number;
  service: Microservice;
}

@Injectable({ providedIn: 'root' })
export class MetricsStreamService {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiClientService);
  private readonly destroyRef = inject(DestroyRef);

  services = signal<Microservice[]>([]);
  activeTransport = signal<TransportType>('WebSocket');
  preferredTransport = signal<TransportType>('WebSocket');
  connectionStatus = signal<ConnectionStatus>('Offline');
  isStale = signal<boolean>(false);
  lastEventTime = signal<number>(Date.now());
  secondsSinceLastEvent = signal<number>(0);
  eventsPerSecond = signal<number>(0);
  malformedEventCount = signal(0);

  searchQuery = signal<string>('');
  statusFilter = signal<string>('all');
  sortColumn = signal<SortColumn>('p95');
  sortDirection = signal<SortDirection>('desc');

  private ws: WebSocket | null = null;
  private sseSource: EventSource | null = null;
  private sseMetricsHandler: EventListener | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private pollingAbortController: AbortController | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
  private sseStabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private transportRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private priorityRetryTimer: ReturnType<typeof setInterval> | null = null;
  private pendingEvents: StreamEnvelope[] = [];
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly seenEventIds = new Set<string>();
  private readonly recentEventKeys = new Map<string, number>();
  private readonly serviceSequences = new Map<string, number>();
  private globalOffset: number | null = null;
  private replayRequested = false;
  private wsFailures = 0;
  private sseFailures = 0;
  private lastHeartbeatAt = 0;
  private eventCount = 0;
  private pollingRequestInFlight = false;
  private initialLoadPromise: Promise<void> | null = null;
  private transportGeneration = 0;
  private onlineHandler = () => this.handleOnline();
  private offlineHandler = () => this.handleOffline();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onlineHandler);
      window.addEventListener('offline', this.offlineHandler);
    }

    let wasAuthenticated = false;
    effect(() => {
      const authenticated = this.auth.isAuthenticated();
      if (!authenticated) {
        this.cleanupTransports();
        this.resetEventIntegrity();
        this.services.set([]);
        this.connectionStatus.set('Offline');
        wasAuthenticated = false;
        return;
      }
      if (wasAuthenticated) return;
      wasAuthenticated = true;
      untracked(() => void this.loadServicesFromBackend());
    });

    this.startStaleChecker();
    this.destroyRef.onDestroy(() => {
      this.cleanupTransports();
      if (this.staleTimer) clearInterval(this.staleTimer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', this.onlineHandler);
        window.removeEventListener('offline', this.offlineHandler);
      }
    });
  }

  async loadServicesFromBackend(): Promise<void> {
    if (!this.auth.isAuthenticated() || isTestEnv || typeof fetch === 'undefined') return;
    if (this.initialLoadPromise) return this.initialLoadPromise;

    this.initialLoadPromise = (async () => {
      this.logInfo('Initial service snapshot request: GET /api/services');
      try {
        const response = await this.api.request('services');
        if (!response.ok) throw new Error(`Request failed (${response.status}).`);
        const body = await response.json();
        if (!Array.isArray(body?.data)) throw new Error('The services response did not contain a data array.');
        if (!body.data.every((service: unknown) => this.isMicroservice(service))) {
          throw new Error('The services response contained an invalid service record.');
        }
        if (!this.auth.isAuthenticated()) return;
        this.services.set(body.data);
        this.lastEventTime.set(Date.now());
        this.logInfo(`Initial service snapshot loaded (${body.data.length} services).`);
      } catch (error) {
        console.error('Could not load services from backend:', error);
        this.connectionStatus.set('Offline');
      } finally {
        this.initialLoadPromise = null;
        if (this.auth.isAuthenticated() && !this.hasActiveTransport()) {
          this.activateTransport(this.preferredTransport());
        }
      }
    })();

    return this.initialLoadPromise;
  }

  connectWebSocket(): void {
    this.setTransport('WebSocket');
  }

  private openWebSocket(upgradeAttempt: boolean, generation = this.transportGeneration): void {
    if (
      isTestEnv ||
      generation !== this.transportGeneration ||
      typeof window === 'undefined' ||
      typeof WebSocket === 'undefined' ||
      this.ws
    ) return;

    if (!upgradeAttempt) this.connectionStatus.set('Reconnecting');

    let socket: WebSocket;
    try {
      this.logInfo(`WebSocket connection attempt: ${webSocketUrl()}`);
      socket = new WebSocket(webSocketUrl());
      this.ws = socket;
    } catch (error) {
      this.handleWebSocketFailure(
        null,
        upgradeAttempt,
        error instanceof Error ? error : new Error(String(error)),
        generation
      );
      return;
    }

    this.connectionTimeout = setTimeout(() => {
      if (generation === this.transportGeneration &&
          this.ws === socket && socket.readyState !== WebSocket.OPEN) {
        this.handleWebSocketFailure(
          socket,
          upgradeAttempt,
          new Error('WebSocket connection timed out.'),
          generation
        );
      }
    }, CONNECTION_TIMEOUT_MS);

    socket.onopen = () => {
      if (generation !== this.transportGeneration || this.ws !== socket) return;
      this.clearConnectionTimeout();
      this.clearTransportRetry();
      this.wsFailures = 0;
      this.closeFallbackTransports();
      this.activeTransport.set('WebSocket');
      this.connectionStatus.set('Live');
      this.logInfo('WebSocket connection opened; active transport: WebSocket.');
      this.noteActivity();
      this.startHeartbeatMonitor();
      this.startPriorityRetries();
    };
    socket.onmessage = event => {
      if (generation !== this.transportGeneration || this.ws !== socket) return;
      this.lastHeartbeatAt = Date.now();
      this.handleStreamEvent(event.data);
    };
    socket.onerror = () => {
      if (generation !== this.transportGeneration || this.ws !== socket) return;
      this.logInfo('WebSocket transport error.');
      this.handleWebSocketFailure(
        socket,
        upgradeAttempt,
        new Error('WebSocket transport error.'),
        generation
      );
    };
    socket.onclose = event => {
      if (generation !== this.transportGeneration || this.ws !== socket) return;
      this.logInfo(`WebSocket closed (code ${event.code}): ${event.reason || 'no close reason provided'}.`);
      this.handleWebSocketFailure(
        socket,
        upgradeAttempt,
        new Error(`WebSocket closed with code ${event.code}${event.reason ? `: ${event.reason}` : ''}.`),
        generation
      );
    };
  }

  connectSSE(): void {
    this.setTransport('SSE');
  }

  private openSSE(generation = this.transportGeneration): void {
    if (isTestEnv || generation !== this.transportGeneration) return;
    if (typeof EventSource === 'undefined') {
      this.startPolling(generation);
      return;
    }
    if (this.sseSource) return;
    this.connectionStatus.set('Reconnecting');
    try {
      const url = sseUrl(this.globalOffset ?? undefined);
      this.logInfo(`SSE connection attempt: ${url}`);
      const source = new EventSource(url);
      this.sseSource = source;
      const onMetricsUpdate: EventListener = event => {
        if (generation !== this.transportGeneration || this.sseSource !== source) return;
        this.handleStreamEvent((event as MessageEvent).data);
      };
      this.sseMetricsHandler = onMetricsUpdate;
      source.addEventListener('metrics-update', onMetricsUpdate);
      source.onopen = () => this.handleSseOpen(source, generation);
      source.onmessage = event => {
        if (generation === this.transportGeneration && this.sseSource === source) {
          this.handleStreamEvent(event.data);
        }
      };
      source.onerror = () => this.handleSseError(source, generation);
    } catch (error) {
      if (generation !== this.transportGeneration) return;
      this.sseFailures++;
      console.error('Could not open the metrics SSE stream:', error);
      if (this.sseFailures >= 3) this.startPolling(generation);
      else this.scheduleTransportRetry(() => this.openSSE(generation), this.sseFailures, generation);
    }
  }

  private handleSseOpen(source: EventSource, generation: number): void {
    if (generation !== this.transportGeneration || this.sseSource !== source) return;
    this.clearTransportRetry();
    this.closeWebSocket();
    this.stopPolling();
    this.activeTransport.set('SSE');
    this.logInfo('SSE connection opened; active transport: SSE.');
    this.connectionStatus.set('Live');
    this.noteActivity();
    this.clearSseStabilityTimer();
    this.sseStabilityTimer = setTimeout(() => {
      this.sseStabilityTimer = null;
      if (generation === this.transportGeneration &&
          this.sseSource === source && source.readyState === 1) {
        this.sseFailures = 0;
      }
    }, SSE_STABLE_CONNECTION_MS);
    this.startPriorityRetries();
  }

  private handleSseError(source: EventSource, generation: number): void {
    if (generation !== this.transportGeneration || this.sseSource !== source) return;
    this.clearSseStabilityTimer();
    this.sseFailures++;
    console.warn(`Metrics SSE connection failed (${this.sseFailures}/3).`);
    this.logInfo(`SSE connection failure ${this.sseFailures}/3.`);
    this.connectionStatus.set('Reconnecting');

    this.closeSse();
    if (this.sseFailures >= 3) {
      this.startPolling(generation);
      return;
    }

    this.scheduleTransportRetry(
      () => this.openSSE(generation),
      this.sseFailures,
      generation
    );
  }

  private startPolling(generation = this.transportGeneration): void {
    if (!this.auth.isAuthenticated() || generation !== this.transportGeneration) return;
    if (this.pollingTimer) return;
    this.closeWebSocket();
    this.closeSse();
    this.connectionStatus.set('Reconnecting');
    const poll = async () => {
      if (generation !== this.transportGeneration || this.pollingTimer === null) return;
      if (this.pollingRequestInFlight) return;
      this.pollingRequestInFlight = true;
      const controller = new AbortController();
      this.pollingAbortController = controller;
      try {
        const response = await this.api.request('services/snapshot', { signal: controller.signal });
        if (!response.ok) throw new Error(`Request failed (${response.status}).`);
        const body = await response.json();
        if (!Array.isArray(body?.data)) throw new Error('The services response did not contain a data array.');
        if (!body.data.every((service: unknown) => this.isMicroservice(service))) {
          throw new Error('The services response contained an invalid service record.');
        }
        if (!this.auth.isAuthenticated() || controller.signal.aborted ||
            generation !== this.transportGeneration || this.pollingTimer === null) return;
        this.services.set(body.data);
        if (typeof body.offset === 'number' && Number.isSafeInteger(body.offset)) {
          this.globalOffset = body.offset;
        }
        this.setServiceSequences(body.sequences);
        this.activeTransport.set('Polling');
        this.connectionStatus.set('Live');
        this.noteActivity();
      } catch (error) {
        if (!controller.signal.aborted && generation === this.transportGeneration &&
            this.pollingTimer !== null) {
          console.error('Metrics polling failed:', error);
          this.connectionStatus.set('Offline');
        }
      } finally {
        if (this.pollingAbortController === controller) {
          this.pollingAbortController = null;
          this.pollingRequestInFlight = false;
        }
      }
    };
    this.pollingTimer = setInterval(() => void poll(), POLLING_INTERVAL_MS);
    this.logInfo(`Polling started (${POLLING_INTERVAL_MS}ms interval).`);
    void poll();
    this.startPriorityRetries();
  }

  handleStreamEvent(raw: unknown): void {
    try {
      if (typeof raw !== 'string') throw new Error('Stream event payload must be a string.');
      const envelope = JSON.parse(raw) as StreamEnvelope;
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw new Error('Stream event must be a JSON object.');
      }
      if (envelope.type === 'ping' || envelope.type === 'pong' || envelope.type === 'heartbeat') {
        this.lastHeartbeatAt = Date.now();
        return;
      }
      if (envelope.type !== 'metrics-update') {
        throw new Error('Stream event has an unsupported type.');
      }
      if (envelope.offset !== undefined &&
          (typeof envelope.offset !== 'number' || !Number.isFinite(envelope.offset))) {
        throw new Error('Stream event offset must be a finite number.');
      }
      const updates = envelope.updatedServices ?? envelope.services;
      if (!Array.isArray(updates)) {
        throw new Error('Metrics event must contain an updated services array.');
      }
      const eventKey = typeof envelope.eventId === 'string'
        ? `id:${envelope.eventId}`
        : envelope.replayFrom !== undefined
          ? `replay:${envelope.replayFrom}:${envelope.offset}`
          : typeof envelope.offset === 'number'
          ? `offset:${envelope.offset}`
          : `payload:${JSON.stringify(envelope)}`;
      const previousTime = this.recentEventKeys.get(eventKey);
      if (this.seenEventIds.has(eventKey) ||
          (previousTime !== undefined && Date.now() - previousTime <= 1000)) return;
      this.rememberEventId(eventKey);
      if (envelope.snapshot === true || envelope.replayFrom !== undefined) {
        this.applyEnvelope(envelope);
        if (envelope.replayFrom !== undefined) {
          this.replayRequested = false;
          this.flushPendingEvents();
        }
        return;
      }
      if (typeof envelope.offset === 'number' && Number.isFinite(envelope.offset)) {
        this.pendingEvents.push(envelope);
        if (!this.pendingFlushTimer) {
          this.pendingFlushTimer = setTimeout(() => this.flushPendingEvents(), 1000);
        }
        return;
      }
      this.applyEnvelope(envelope);
    } catch (error) {
      this.malformedEventCount.update(count => count + 1);
      console.warn('Ignoring malformed metrics event:', error);
    }
  }

  flushPendingEvents(): void {
    if (this.pendingFlushTimer) clearTimeout(this.pendingFlushTimer);
    this.pendingFlushTimer = null;
    const events = this.pendingEvents.splice(0).sort(
      (left, right) => Number(left.offset) - Number(right.offset)
    );
    for (const envelope of events) this.applyEnvelope(envelope);
  }

  private applyEnvelope(envelope: StreamEnvelope): void {
    const offset = typeof envelope.offset === 'number' ? envelope.offset : null;
    const updates = envelope.updatedServices ?? envelope.services;
    if (!Array.isArray(updates)) {
      this.malformedEventCount.update(count => count + 1);
      console.warn('Ignoring metrics event without a services array.');
      return;
    }

    if (envelope.snapshot === true) {
      if (offset !== null) this.globalOffset = offset;
      this.serviceSequences.clear();
      if (envelope.sequences && typeof envelope.sequences === 'object') {
        for (const [serviceId, sequence] of Object.entries(envelope.sequences)) {
          if (typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 0) {
            this.serviceSequences.set(serviceId, sequence);
          }
        }
      }
      const snapshotServices = updates.filter((item): item is Microservice => this.isMicroservice(item));
      this.applySnapshot(snapshotServices);
      if (snapshotServices.length > 0) this.noteActivity();
      return;
    }

    const events = Array.isArray(envelope.events) ? envelope.events : null;
    if (events) {
      const orderedEvents = events
        .filter((event): event is SequencedMetricEvent => this.isSequencedEvent(event))
        .sort((left, right) => left.offset - right.offset);
      if (orderedEvents.length !== events.length) {
        this.malformedEventCount.update(count => count + events.length - orderedEvents.length);
        console.warn('Ignoring malformed events in metrics batch.');
      }
      if (orderedEvents.length === 0) return;

      const cursor = this.globalOffset;
      const firstNewEvent = orderedEvents.find(event => cursor === null || event.offset > cursor);
      if (!firstNewEvent) return;
      if (cursor !== null && firstNewEvent.offset > cursor + 1) {
        this.requestReplay(cursor);
        return;
      }

      const accepted: Microservice[] = [];
      let nextOffset = cursor;
      for (const event of orderedEvents) {
        if (nextOffset !== null && event.offset <= nextOffset) continue;
        if (nextOffset !== null && event.offset !== nextOffset + 1) {
          this.requestReplay(nextOffset);
          break;
        }
        const previousSequence = this.serviceSequences.get(event.serviceId);
        if (previousSequence !== undefined && event.sequence <= previousSequence) {
          nextOffset = event.offset;
          continue;
        }
        if (previousSequence !== undefined && event.sequence > previousSequence + 1) {
          console.warn(`Sequence gap detected for ${event.serviceId}; requesting stream replay.`);
          this.requestReplay(nextOffset ?? 0);
          break;
        }
        accepted.push(event.service);
        this.serviceSequences.set(event.serviceId, event.sequence);
        nextOffset = event.offset;
      }
      if (nextOffset !== null) this.globalOffset = nextOffset;
      this.applyUpdates(accepted);
      if (accepted.length > 0) this.noteActivity();
      return;
    }

    if (offset !== null && this.globalOffset !== null) {
      if (offset <= this.globalOffset) return;
      if (offset > this.globalOffset + 1) {
        this.requestReplay(this.globalOffset);
        return;
      }
    }
    const accepted: Microservice[] = [];
    for (const item of updates) {
      if (!this.isMicroservice(item)) {
        this.malformedEventCount.update(count => count + 1);
        console.warn('Ignoring malformed service update:', item);
        continue;
      }
      const service = item as Microservice & { sequence?: number; seq?: number };
      const envelopeSequence = envelope.serviceId === service.id &&
        typeof envelope.sequence === 'number'
        ? envelope.sequence
        : undefined;
      const sequence = typeof service.sequence === 'number'
        ? service.sequence
        : service.seq ?? envelopeSequence;
      const previousSequence = this.serviceSequences.get(service.id);
      if (sequence !== undefined) {
        if (!Number.isFinite(sequence)) {
          this.malformedEventCount.update(count => count + 1);
          console.warn(`Ignoring invalid sequence for ${service.id}.`);
          continue;
        }
        if (previousSequence !== undefined && sequence <= previousSequence) continue;
        if (previousSequence !== undefined && sequence > previousSequence + 1) {
          console.warn(`Sequence gap detected for ${service.id}; requesting stream replay.`);
          this.requestReplay(this.globalOffset ?? 0);
        }
        this.serviceSequences.set(service.id, sequence);
      }
      accepted.push(service);
    }
    if (offset !== null && accepted.length > 0) {
      this.globalOffset = offset;
    }
    this.applyUpdates(accepted);
    if (accepted.length > 0) this.noteActivity();
  }

  private isSequencedEvent(value: unknown): value is SequencedMetricEvent {
    if (!value || typeof value !== 'object') return false;
    const event = value as Partial<SequencedMetricEvent>;
    return typeof event.offset === 'number' && Number.isSafeInteger(event.offset) &&
      typeof event.serviceId === 'string' &&
      typeof event.sequence === 'number' && Number.isSafeInteger(event.sequence) &&
      this.isMicroservice(event.service);
  }

  private applySnapshot(snapshot: Microservice[]): void {
    this.services.set(snapshot);
  }

  private requestReplay(since: number): void {
    if (this.replayRequested) return;
    this.replayRequested = true;
    this.logInfo(`Requesting replay: GET /api/services/replay?since=${since}`);
    void this.loadReplay(since);
  }

  private async loadReplay(since: number): Promise<void> {
    try {
      const response = await this.api.request(`services/replay?since=${since}`);
      const body = await response.json();
      if (response.status === 410) {
        const snapshot = body?.snapshot ?? body;
        if (!Array.isArray(snapshot?.data) ||
            !snapshot.data.every((service: unknown) => this.isMicroservice(service))) {
          throw new Error('The expired replay response did not contain a valid snapshot.');
        }
        this.applySnapshot(snapshot.data);
        if (typeof snapshot.offset === 'number' && Number.isSafeInteger(snapshot.offset)) {
          this.globalOffset = snapshot.offset;
        }
        this.setServiceSequences(snapshot.sequences);
        this.replayRequested = false;
        this.noteActivity();
        this.flushPendingEvents();
        return;
      }
      if (!response.ok) throw new Error(`Replay request failed (${response.status}).`);
      if (!Array.isArray(body?.events)) throw new Error('The replay response did not contain an events array.');
      const replayEvents = body.events.filter((event: unknown) => this.isSequencedEvent(event));
      if (replayEvents.length !== body.events.length) {
        this.malformedEventCount.update(count => count + body.events.length - replayEvents.length);
        console.warn('Replay response contained malformed metric events.');
      }
      const lastOffset = replayEvents.length > 0
        ? replayEvents[replayEvents.length - 1].offset
        : this.globalOffset;
      this.handleStreamEvent(JSON.stringify({
        type: 'metrics-update',
        updatedServices: replayEvents.map((event: SequencedMetricEvent) => event.service),
        events: replayEvents,
        offset: lastOffset,
        replayFrom: since
      }));
      this.replayRequested = false;
      this.flushPendingEvents();
    } catch (error) {
      this.replayRequested = false;
      console.error('Could not replay metrics events:', error);
      this.connectionStatus.set('Offline');
    }
  }

  private isMicroservice(value: unknown): value is Microservice {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<Microservice>;
    return typeof item.id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.team === 'string' &&
      (item.status === 'healthy' || item.status === 'degraded' || item.status === 'down') &&
      typeof item.p95 === 'number' && Number.isFinite(item.p95) &&
      typeof item.errRate === 'number' && Number.isFinite(item.errRate) &&
      typeof item.rps === 'number' && Number.isFinite(item.rps) &&
      typeof item.lastUpdated === 'number' && Number.isFinite(item.lastUpdated);
  }

  private setServiceSequences(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    this.serviceSequences.clear();
    for (const [serviceId, sequence] of Object.entries(value)) {
      if (typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 0) {
        this.serviceSequences.set(serviceId, sequence);
      }
    }
  }

  private applyUpdates(updatedServices: Microservice[]): void {
    if (updatedServices.length === 0) return;
    const updates = new Map(updatedServices.map(service => [service.id, service]));
    this.services.update(current => {
      const currentIds = new Set(current.map(service => service.id));
      return [
        ...current.map(service => updates.get(service.id) ?? service),
        ...updatedServices.filter(service => !currentIds.has(service.id))
      ];
    });
  }

  private handleWebSocketFailure(
    socket: WebSocket | null,
    upgradeAttempt: boolean,
    error: Error,
    generation = this.transportGeneration
  ): void {
    if (generation !== this.transportGeneration) return;
    if (socket && this.ws !== socket) return;
    this.clearConnectionTimeout();
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch { /* already closed */ }
    }
    this.ws = null;
    this.stopHeartbeatMonitor();
    this.wsFailures++;
    console.warn('Metrics WebSocket failed:', error);
    this.logInfo(`WebSocket failure ${this.wsFailures}/3: ${error.message}`);
    if (upgradeAttempt && this.activeTransport() !== 'WebSocket') {
      if (this.activeTransport() === 'SSE') this.openSSE();
      else if (this.activeTransport() === 'Polling') this.startPolling();
      return;
    }
    this.connectionStatus.set('Reconnecting');
    if (this.wsFailures >= 3) {
      this.wsFailures = 0;
      this.activateTransport('SSE');
    } else {
      this.scheduleTransportRetry(
        () => this.openWebSocket(false, generation),
        this.wsFailures,
        generation
      );
    }
  }

  private startPriorityRetries(): void {
    if (this.preferredTransport() !== 'WebSocket') return;
    if (this.priorityRetryTimer) return;
    this.priorityRetryTimer = setInterval(() => {
      if (
        this.preferredTransport() === 'WebSocket' &&
        this.activeTransport() !== 'WebSocket' &&
        this.auth.isAuthenticated() &&
        !this.ws
      ) {
        this.openWebSocket(true, this.transportGeneration);
      }
    }, HIGHER_PRIORITY_RETRY_MS);
  }

  private scheduleTransportRetry(
    callback: () => void,
    failureCount: number,
    generation = this.transportGeneration
  ): void {
    if (this.transportRetryTimer) clearTimeout(this.transportRetryTimer);
    const base = Math.min(30_000, 1000 * 2 ** Math.max(0, failureCount - 1));
    const delay = Math.min(30_000, Math.round(base * (0.5 + Math.random())));
    this.transportRetryTimer = setTimeout(() => {
      this.transportRetryTimer = null;
      if (generation === this.transportGeneration) callback();
    }, delay);
  }

  private clearTransportRetry(): void {
    if (this.transportRetryTimer) clearTimeout(this.transportRetryTimer);
    this.transportRetryTimer = null;
  }

  private startHeartbeatMonitor(): void {
    this.stopHeartbeatMonitor();
    this.lastHeartbeatAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeatAt >= HEARTBEAT_TIMEOUT_MS && this.ws) {
        this.handleWebSocketFailure(
          this.ws,
          false,
          new Error('Metrics heartbeat timed out.'),
          this.transportGeneration
        );
      }
    }, 10_000);
  }

  private stopHeartbeatMonitor(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private closeFallbackTransports(): void {
    this.closeSse();
    this.stopPolling();
  }

  private closeWebSocket(): void {
    this.clearConnectionTimeout();
    this.stopHeartbeatMonitor();
    if (!this.ws) return;
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onerror = null;
    this.ws.onclose = null;
    try { this.ws.close(); } catch { /* already closed */ }
    this.ws = null;
  }

  private stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
      this.logInfo('Polling stopped.');
    }
    this.pollingAbortController?.abort();
    this.pollingAbortController = null;
    this.pollingRequestInFlight = false;
  }

  private closeSse(): void {
    this.clearSseStabilityTimer();
    if (!this.sseSource) return;
    this.sseSource.onopen = null;
    this.sseSource.onmessage = null;
    this.sseSource.onerror = null;
    if (this.sseMetricsHandler) {
      this.sseSource.removeEventListener('metrics-update', this.sseMetricsHandler);
      this.sseMetricsHandler = null;
    }
    this.sseSource.close();
    this.sseSource = null;
  }

  private clearSseStabilityTimer(): void {
    if (this.sseStabilityTimer) clearTimeout(this.sseStabilityTimer);
    this.sseStabilityTimer = null;
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
  }

  private cleanupTransports(): void {
    this.transportGeneration++;
    this.clearConnectionTimeout();
    this.stopHeartbeatMonitor();
    this.clearTransportRetry();
    if (this.priorityRetryTimer) clearInterval(this.priorityRetryTimer);
    if (this.pendingFlushTimer) clearTimeout(this.pendingFlushTimer);
    this.closeWebSocket();
    this.closeSse();
    this.stopPolling();
    this.transportRetryTimer = null;
    this.priorityRetryTimer = null;
    this.pendingFlushTimer = null;
    this.pendingEvents = [];
  }

  private resetEventIntegrity(): void {
    this.seenEventIds.clear();
    this.recentEventKeys.clear();
    this.serviceSequences.clear();
    this.globalOffset = null;
    this.replayRequested = false;
  }

  private noteActivity(): void {
    this.lastEventTime.set(Date.now());
    this.isStale.set(false);
    this.eventCount++;
    this.connectionStatus.set('Live');
  }

  private rememberEventId(key: string): void {
    this.recentEventKeys.set(key, Date.now());
    if (key.startsWith('id:') || key.startsWith('offset:')) this.seenEventIds.add(key);
    if (this.seenEventIds.size > 2000) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest) {
        this.seenEventIds.delete(oldest);
        this.recentEventKeys.delete(oldest);
      }
    }
    if (this.recentEventKeys.size > 2500) {
      const oldest = this.recentEventKeys.keys().next().value;
      if (oldest) this.recentEventKeys.delete(oldest);
    }
  }

  private handleOnline(): void {
    if (this.auth.isAuthenticated()) this.setTransport(this.preferredTransport());
  }

  private handleOffline(): void {
    this.cleanupTransports();
    this.connectionStatus.set('Offline');
  }

  filteredServices = computed(() => {
    let list = this.services();
    const search = this.searchQuery().trim().toLowerCase();
    const status = this.statusFilter();
    if (status !== 'all') list = list.filter(item => item.status === status);
    if (search) {
      list = list.filter(item =>
        item.name.toLowerCase().includes(search) ||
        item.id.toLowerCase().includes(search) ||
        item.team.toLowerCase().includes(search)
      );
    }

    const column = this.sortColumn();
    const ascending = this.sortDirection() === 'asc';
    return [...list].sort((a, b) => {
      const left = a[column];
      const right = b[column];
      if (typeof left === 'string' && typeof right === 'string') {
        return ascending ? left.localeCompare(right) : right.localeCompare(left);
      }
      return ascending ? Number(left) - Number(right) : Number(right) - Number(left);
    });
  });

  statusCounts = computed(() => {
    const all = this.services();
    let healthy = 0, degraded = 0, down = 0;
    for (const service of all) {
      if (service.status === 'healthy') healthy++;
      else if (service.status === 'degraded') degraded++;
      else if (service.status === 'down') down++;
    }
    return { total: all.length, healthy, degraded, down };
  });

  private startStaleChecker(): void {
    this.staleTimer = setInterval(() => {
      const secondsPassed = Math.floor((Date.now() - this.lastEventTime()) / 1000);
      this.secondsSinceLastEvent.set(secondsPassed);
      this.eventsPerSecond.set(this.eventCount);
      this.eventCount = 0;
      if (secondsPassed >= 10) {
        this.isStale.set(true);
        if (this.connectionStatus() === 'Live') this.connectionStatus.set('Stale');
      } else {
        this.isStale.set(false);
        if (this.connectionStatus() === 'Stale') this.connectionStatus.set('Live');
      }
    }, 1000);
  }

  setTransport(type: TransportType): void {
    if (
      this.preferredTransport() === type &&
      this.activeTransport() === type &&
      this.hasActiveTransport()
    ) return;
    this.preferredTransport.set(type);
    this.activateTransport(type);
  }

  private activateTransport(type: TransportType): void {
    this.cleanupTransports();
    if (type === 'SSE') this.sseFailures = 0;
    this.logInfo(`Active transport selected: ${type}.`);
    if (!this.auth.isAuthenticated()) {
      this.connectionStatus.set('Offline');
      return;
    }
    this.connectionStatus.set('Reconnecting');
    this.isStale.set(false);
    if (type === 'WebSocket') this.openWebSocket(false);
    else if (type === 'SSE') this.openSSE();
    else this.startPolling();
  }

  private hasActiveTransport(): boolean {
    return this.ws !== null || this.sseSource !== null || this.pollingTimer !== null;
  }

  private logInfo(message: string): void {
    if (isDevelopment) console.info(`[MetricsStream] ${message}`);
  }

  simulateFailure(type: 'ws-fail' | 'sse-fail' | 'stale' | 'offline'): void {
    if (type === 'ws-fail') {
      this.wsFailures = 2;
      this.handleWebSocketFailure(this.ws, false, new Error('Simulated WebSocket failure.'));
    } else if (type === 'sse-fail') {
      this.sseFailures = 2;
      this.closeSse();
      this.startPolling();
    } else if (type === 'stale') {
      this.lastEventTime.set(Date.now() - 11_000);
      this.isStale.set(true);
      this.connectionStatus.set('Stale');
    } else {
      this.handleOffline();
    }
  }

  recoverHealthy(): void {
    if (this.auth.isAuthenticated()) this.connectWebSocket();
  }

  getServiceById(id: string): Microservice | undefined {
    return this.services().find(service => service.id === id);
  }
}
