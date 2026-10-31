import { TestBed } from '@angular/core/testing';
import { RulesEngineService } from './rules-engine.service';
import { MetricsStreamService } from './metrics-stream.service';
import { DummyDataService } from './dummy-data.service';
import { conditionMatches } from './rules-engine.service';
import { ApiClientService } from './api-client.service';
import { firstValueFrom } from 'rxjs';

describe('RulesEngineService', () => {
  let service: RulesEngineService;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ data: [] })
    }));
    TestBed.configureTestingModule({
      providers: [RulesEngineService, MetricsStreamService, DummyDataService]
    });

    service = TestBed.inject(RulesEngineService);
    service.rules.set([
      {
        id: 'r-1',
        name: 'High Latency Warning',
        warningThreshold: 300,
        criticalThreshold: 500,
        conditions: [{ metric: 'p95', operator: '>', threshold: 500, durationSec: 10 }],
        enabled: true,
        createdAt: 'Today, 10:00 AM'
      }
    ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should have initial rules', () => {
    expect(service.rules().length).toBeGreaterThan(0);
  });

  it('should check name availability', () => {
    const existing = service.rules()[0];
    expect(service.checkNameAvailable(existing.name)).toBe(false);
    expect(service.checkNameAvailable('Totally Unique New Rule')).toBe(true);
  });

  it('should toggle rule enabled state', async () => {
    const rule = service.rules()[0];
    const initial = rule.enabled;
    await service.toggleRule(rule.id);
    const updated = service.rules().find(r => r.id === rule.id);
    expect(updated?.enabled).toBe(!initial);
  });

  it('should save and delete a rule', async () => {
    const count = service.rules().length;
    const savedRule = {
      id: 'server-rule-id',
      name: 'Test Rule',
      conditions: [{ metric: 'p95', operator: '>', threshold: 400, durationSec: 10 }],
      enabled: true,
      createdAt: 'Today'
    };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      headers: new Headers(),
      json: async () => ({ success: true, data: savedRule })
    } as Response);
    await service.saveRule({
      id: 'test-1',
      name: 'Test Rule',
      conditions: [{ metric: 'p95', operator: '>', threshold: 400, durationSec: 10 }],
      enabled: true,
      createdAt: 'Today'
    });

    expect(service.rules().length).toBe(count + 1);
    expect(service.rules().some(rule => rule.id === 'server-rule-id')).toBe(true);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ success: true })
    } as Response);
    await service.deleteRule('server-rule-id');
    expect(service.rules().length).toBe(count);
  });

  it('evaluates all four comparison operators with exact boundary semantics', () => {
    expect(conditionMatches(5, '>', 5)).toBe(false);
    expect(conditionMatches(5, '>=', 5)).toBe(true);
    expect(conditionMatches(5, '<', 5)).toBe(false);
    expect(conditionMatches(5, '<=', 5)).toBe(true);
  });

  it('rolls back a failed create and sends an idempotency key', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers(),
      json: async () => ({})
    } as Response);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const newRule = {
      id: 'failed-create',
      name: 'Failed create',
      conditions: [{ metric: 'p95' as const, operator: '>' as const, threshold: 500, durationSec: 10 }],
      enabled: true,
      createdAt: 'Today'
    };

    await expect(service.saveRule(newRule)).resolves.toBe(false);

    expect(service.rules().some(rule => rule.id === newRule.id)).toBe(false);
    const requestHeaders = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers);
    expect(requestHeaders.get('Idempotency-Key')).toBeTruthy();
  });

  it('enforces condition duration, deduplicates incidents, and rearms after resolution', () => {
    const stream = TestBed.inject(MetricsStreamService);
    stream.services.set([
      { id: 'svc-1', name: 'service', team: 'team', status: 'healthy', p95: 501, errRate: 0, rps: 1, lastUpdated: Date.now() }
    ]);

    service.evaluateRules(1000);
    service.evaluateRules(10_999);
    expect(service.incidents()).toHaveLength(0);
    service.evaluateRules(11_000);
    service.evaluateRules(12_000);
    expect(service.incidents()).toHaveLength(1);

    stream.services.update(services => services.map(item => ({ ...item, p95: 500 })));
    service.evaluateRules(13_000);
    stream.services.update(services => services.map(item => ({ ...item, p95: 501 })));
    service.evaluateRules(14_000);
    service.evaluateRules(23_999);
    expect(service.incidents()).toHaveLength(1);
    service.evaluateRules(24_000);
    expect(service.incidents()).toHaveLength(2);
  });

  it('checks rule-name uniqueness with the backend contract and excludeId', async () => {
    const api = TestBed.inject(ApiClientService);
    const request = vi.spyOn(api, 'request').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, available: true })
    } as Response);

    await expect(firstValueFrom(service.checkNameAvailableRemotely('New rule', 'rule-1')))
      .resolves.toBe(true);
    expect(request).toHaveBeenCalledWith('rules/check-name?name=New+rule&excludeId=rule-1');
  });
});
