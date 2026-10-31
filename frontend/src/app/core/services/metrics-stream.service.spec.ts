import { TestBed } from '@angular/core/testing';
import { MetricsStreamService } from './metrics-stream.service';
import { DummyDataService } from './dummy-data.service';
import { AuthService } from './auth.service';
import { ApiClientService } from './api-client.service';

interface MetricsStreamLifecycleAccess {
  pollingTimer: ReturnType<typeof setInterval> | null;
  sseSource: EventSource | null;
  sseFailures: number;
  transportGeneration: number;
  handleSseOpen(source: EventSource, generation: number): void;
  handleSseError(source: EventSource, generation: number): void;
  startPolling(generation: number): void;
}

describe('MetricsStreamService', () => {
  let service: MetricsStreamService;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    TestBed.configureTestingModule({
      providers: [MetricsStreamService, DummyDataService]
    });

    service = TestBed.inject(MetricsStreamService);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should initialize services as clean empty state', () => {
    expect(Array.isArray(service.services())).toBe(true);
  });

  it('should not request services before authentication', () => {
    service.loadServicesFromBackend();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should load services after authentication', () => {
    const loadServices = vi.spyOn(service, 'loadServicesFromBackend');
    const auth = TestBed.inject(AuthService);

    TestBed.tick();
    expect(loadServices).not.toHaveBeenCalled();

    auth.currentUser.set({ id: 'u-1', email: 'operator@pulse.dev', role: 'operator' });
    auth.accessToken.set('server-token');
    TestBed.tick();

    expect(loadServices).toHaveBeenCalledOnce();
  });

  it('does not report a transport as live before it connects', () => {
    expect(service.activeTransport()).toBe('WebSocket');

    service.setTransport('SSE');
    expect(service.preferredTransport()).toBe('SSE');
    expect(service.connectionStatus()).toBe('Offline');
    expect(service.activeTransport()).toBe('WebSocket');

    service.setTransport('Polling');
    expect(service.preferredTransport()).toBe('Polling');

    service.setTransport('WebSocket');
    expect(service.preferredTransport()).toBe('WebSocket');
    expect(service.activeTransport()).toBe('WebSocket');
  });

  it('should filter services by search query and status', () => {
    service.services.set([
      { id: 'svc-0001', name: 'auth-api', team: 'payments', status: 'healthy', p95: 120, errRate: 0.1, rps: 500, lastUpdated: Date.now() },
      { id: 'svc-0002', name: 'order-api', team: 'checkout', status: 'degraded', p95: 450, errRate: 4.5, rps: 200, lastUpdated: Date.now() }
    ]);
    service.searchQuery.set('svc-0001');
    const result = service.filteredServices();
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('svc-0001');
  });

  it('does not report a fabricated event rate before events arrive', () => {
    expect(service.eventsPerSecond()).toBe(0);
  });

  it('suppresses duplicate events and rejects old per-service sequences', () => {
    const base = {
      id: 'svc-1', name: 'service', team: 'team', status: 'healthy' as const,
      p95: 100, errRate: 0, rps: 10, lastUpdated: Date.now()
    };
    service.services.set([base]);
    service.handleStreamEvent(JSON.stringify({
      type: 'metrics-update',
      updatedServices: [{ ...base, p95: 200, sequence: 2 }]
    }));
    service.handleStreamEvent(JSON.stringify({
      type: 'metrics-update',
      updatedServices: [{ ...base, p95: 200, sequence: 2 }]
    }));
    service.handleStreamEvent(JSON.stringify({
      type: 'metrics-update',
      updatedServices: [{ ...base, p95: 150, sequence: 1 }]
    }));

    expect(service.services()[0].p95).toBe(200);
  });

  it('counts malformed events without changing service state', () => {
    service.handleStreamEvent('{invalid');

    expect(service.malformedEventCount()).toBe(1);
    expect(service.services()).toEqual([]);
  });

  it('buffers offset events and applies them in order', () => {
    const base = {
      id: 'svc-1', name: 'service', team: 'team', status: 'healthy' as const,
      p95: 100, errRate: 0, rps: 10, lastUpdated: Date.now()
    };
    service.services.set([base]);
    service.handleStreamEvent(JSON.stringify({
      type: 'metrics-update', offset: 2, updatedServices: [{ ...base, p95: 200 }]
    }));
    service.handleStreamEvent(JSON.stringify({
      type: 'metrics-update', offset: 1, updatedServices: [{ ...base, p95: 150 }]
    }));

    service.flushPendingEvents();

    expect(service.services()[0].p95).toBe(200);
  });

  it('does not request snapshots for normal batched WebSocket offsets', () => {
    const api = TestBed.inject(ApiClientService);
    const snapshot = {
      id: 'svc-1', name: 'service', team: 'team', status: 'healthy' as const,
      p95: 100, errRate: 0, rps: 10, lastUpdated: Date.now()
    };
    const request = vi.spyOn(api, 'request').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [snapshot], offset: 100, sequences: { 'svc-1': 10 } })
    } as Response);
    service.handleStreamEvent(JSON.stringify({
      type: 'metrics-update',
      updatedServices: [snapshot],
      offset: 100,
      snapshot: true,
      sequences: { 'svc-1': 10 }
    }));

    const makeBatch = (firstOffset: number, firstSequence: number) => {
      const events = Array.from({ length: 15 }, (_value, index) => {
        const sequence = firstSequence + index;
        const updated = { ...snapshot, p95: 100 + sequence, lastUpdated: Date.now() };
        return {
          offset: firstOffset + index,
          serviceId: snapshot.id,
          sequence,
          timestamp: Date.now(),
          service: updated
        };
      });
      return {
        type: 'metrics-update',
        events,
        updatedServices: events.map(event => event.service),
        offset: events[events.length - 1].offset
      };
    };
    service.handleStreamEvent(JSON.stringify(makeBatch(101, 11)));
    service.handleStreamEvent(JSON.stringify(makeBatch(116, 26)));
    service.flushPendingEvents();

    expect(service.services()[0].p95).toBe(140);
    expect(request).not.toHaveBeenCalled();
  });

  it('polls the backend snapshot on a two-second schedule and stops on transport change', async () => {
    vi.useFakeTimers();
    const api = TestBed.inject(ApiClientService);
    const auth = TestBed.inject(AuthService);
    auth.currentUser.set({ id: 'u-1', email: 'operator@pulse.dev', role: 'operator' });
    auth.accessToken.set('server-token');
    const request = vi.spyOn(api, 'request').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [], offset: 0, sequences: {} })
    } as Response);

    service.setTransport('Polling');
    await vi.advanceTimersByTimeAsync(4500);
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      'services/snapshot',
      'services/snapshot',
      'services/snapshot'
    ]);

    service.setTransport('WebSocket');
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('stops polling when SSE opens and ignores a stale polling start', async () => {
    vi.useFakeTimers();
    const api = TestBed.inject(ApiClientService);
    const auth = TestBed.inject(AuthService);
    auth.currentUser.set({ id: 'u-1', email: 'operator@pulse.dev', role: 'operator' });
    auth.accessToken.set('server-token');
    const request = vi.spyOn(api, 'request').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [], offset: 0, sequences: {} })
    } as Response);

    service.setTransport('Polling');
    await vi.advanceTimersByTimeAsync(0);
    expect(service.activeTransport()).toBe('Polling');
    expect(request).toHaveBeenCalledTimes(1);

    const lifecycle = service as unknown as MetricsStreamLifecycleAccess;
    const source = {
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as unknown as EventSource;
    lifecycle.sseSource = source;
    lifecycle.handleSseOpen(source, lifecycle.transportGeneration);

    expect(service.activeTransport()).toBe('SSE');
    expect(service.connectionStatus()).toBe('Live');
    expect(lifecycle.pollingTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(1);

    const staleGeneration = lifecycle.transportGeneration;
    service.setTransport('WebSocket');
    lifecycle.startPolling(staleGeneration);
    expect(lifecycle.pollingTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses custom retries and resets SSE failures only after a stable connection', () => {
    vi.useFakeTimers();
    const lifecycle = service as unknown as MetricsStreamLifecycleAccess;
    const source = {
      readyState: 0,
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as unknown as EventSource;
    lifecycle.sseSource = source;

    lifecycle.handleSseError(source, lifecycle.transportGeneration);

    expect(source.close).toHaveBeenCalledOnce();
    expect(lifecycle.sseSource).toBeNull();
    expect(lifecycle.sseFailures).toBe(1);
    expect(lifecycle.pollingTimer).toBeNull();

    const reopenedSource = {
      readyState: 1,
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as unknown as EventSource;
    lifecycle.sseSource = reopenedSource;
    lifecycle.handleSseOpen(reopenedSource, lifecycle.transportGeneration);
    expect(lifecycle.sseFailures).toBe(1);
    expect(service.activeTransport()).toBe('SSE');

    vi.advanceTimersByTime(29_999);
    expect(lifecycle.sseFailures).toBe(1);
    vi.advanceTimersByTime(1);
    expect(lifecycle.sseFailures).toBe(0);
    expect(service.connectionStatus()).toBe('Live');
  });

  it('falls back after three SSE failures before the connection is stable', async () => {
    vi.useFakeTimers();
    const auth = TestBed.inject(AuthService);
    auth.currentUser.set({ id: 'u-1', email: 'operator@pulse.dev', role: 'operator' });
    auth.accessToken.set('server-token');
    const api = TestBed.inject(ApiClientService);
    const request = vi.spyOn(api, 'request').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [], offset: 0, sequences: {} })
    } as Response);
    const lifecycle = service as unknown as MetricsStreamLifecycleAccess;

    for (let failure = 1; failure <= 3; failure++) {
      const source = {
        readyState: 0,
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      } as unknown as EventSource;
      lifecycle.sseSource = source;
      lifecycle.handleSseError(source, lifecycle.transportGeneration);

      expect(source.close).toHaveBeenCalledOnce();
      if (failure < 3) {
        const reopenedSource = {
          readyState: 1,
          close: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn()
        } as unknown as EventSource;
        lifecycle.sseSource = reopenedSource;
        lifecycle.handleSseOpen(reopenedSource, lifecycle.transportGeneration);
        await vi.advanceTimersByTimeAsync(5000);
      }
    }

    expect(lifecycle.sseFailures).toBe(3);
    expect(lifecycle.pollingTimer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.activeTransport()).toBe('Polling');
    expect(request).toHaveBeenCalledOnce();
  });


  it('requests REST replay for a real global offset gap', () => {
    const api = TestBed.inject(ApiClientService);
    const replay = vi.spyOn(api, 'request').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, events: [] })
    } as Response);
    const snapshot = {
      id: 'svc-1', name: 'service', team: 'team', status: 'healthy' as const,
      p95: 100, errRate: 0, rps: 10, lastUpdated: Date.now()
    };
    service.handleStreamEvent(JSON.stringify({
      type: 'metrics-update',
      updatedServices: [snapshot],
      offset: 10,
      snapshot: true,
      sequences: { 'svc-1': 10 }
    }));
    const event = {
      offset: 12,
      serviceId: 'svc-1',
      sequence: 12,
      timestamp: Date.now(),
      service: { ...snapshot, p95: 120 }
    };
    service.handleStreamEvent(JSON.stringify({
      type: 'metrics-update',
      updatedServices: [event.service],
      events: [event],
      offset: 12
    }));
    service.flushPendingEvents();

    expect(replay).toHaveBeenCalledWith('services/replay?since=10');
  });

  it('applies the included snapshot when replay history has expired', async () => {
    const api = TestBed.inject(ApiClientService);
    const snapshot = {
      id: 'svc-1', name: 'service', team: 'team', status: 'healthy' as const,
      p95: 700, errRate: 0, rps: 10, lastUpdated: Date.now()
    };
    vi.spyOn(api, 'request').mockResolvedValue({
      ok: false,
      status: 410,
      json: async () => ({
        success: false,
        snapshot: {
          data: [snapshot],
          offset: 25,
          sequences: { 'svc-1': 25 }
        }
      })
    } as Response);
    service.handleStreamEvent(JSON.stringify({
      type: 'metrics-update',
      updatedServices: [{ ...snapshot, p95: 100 }],
      offset: 10,
      snapshot: true,
      sequences: { 'svc-1': 10 }
    }));
    service.handleStreamEvent(JSON.stringify({
      type: 'metrics-update',
      updatedServices: [snapshot],
      events: [{
        offset: 12,
        serviceId: 'svc-1',
        sequence: 12,
        timestamp: Date.now(),
        service: snapshot
      }],
      offset: 12
    }));
    service.flushPendingEvents();
    await Promise.resolve();
    await Promise.resolve();

    expect(service.services()[0].p95).toBe(700);
  });
});
