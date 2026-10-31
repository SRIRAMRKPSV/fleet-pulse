import { MetricEvent, Microservice } from './models';
import { create2000Services } from './dummy-data';

const MAX_EVENT_HISTORY = 10_000;
const MAX_SERVICE_HISTORY = 300;

let services: Microservice[] = create2000Services();
let globalOffset = 0;
const serviceSequences = new Map<string, number>();
const eventHistory: MetricEvent[] = [];

export interface MetricHistoryPoint {
  timestamp: number;
  timeLabel: string;
  p95: number;
  errRate: number;
  rps: number;
}

const serviceHistory = new Map<string, MetricHistoryPoint[]>();

for (const service of services) {
  serviceSequences.set(service.id, 0);
  serviceHistory.set(service.id, [toHistoryPoint(service, service.lastUpdated)]);
}

export function getAll(): Microservice[] {
  return services;
}

export function getById(id: string): Microservice | undefined {
  return services.find(service => service.id === id);
}

export function getLatestOffset(): number {
  return globalOffset;
}

export function getServiceSequences(): Record<string, number> {
  return Object.fromEntries(serviceSequences);
}

export function getEventsAfter(offset: number): {
  events: MetricEvent[];
  expired: boolean;
  latestOffset: number;
  oldestOffset: number | null;
} {
  const oldestOffset = eventHistory[0]?.offset ?? null;
  const expired = oldestOffset !== null && offset < oldestOffset - 1;
  return {
    events: expired ? [] : eventHistory.filter(event => event.offset > offset),
    expired,
    latestOffset: globalOffset,
    oldestOffset
  };
}

export function getHistoryForService(id: string): MetricHistoryPoint[] | undefined {
  const history = serviceHistory.get(id);
  return history ? [...history] : undefined;
}

export function updateMetrics(): { updatedServices: Microservice[]; events: MetricEvent[]; timestamp: number } {
  const updatedServices: Microservice[] = [];
  const events: MetricEvent[] = [];
  const timestamp = Date.now();
  const updateCount = Math.min(15, services.length);
  const indexes = services.map((_service, index) => index);
  for (let i = 0; i < updateCount; i++) {
    const swapIndex = i + Math.floor(Math.random() * (indexes.length - i));
    [indexes[i], indexes[swapIndex]] = [indexes[swapIndex], indexes[i]];
  }

  for (const index of indexes.slice(0, updateCount)) {
    const service = services[index];

    service.p95 = Math.max(25, service.p95 + Math.floor((Math.random() - 0.5) * 16));
    service.errRate = +(Math.max(0, service.errRate + (Math.random() - 0.5) * 0.2)).toFixed(2);
    service.rps = Math.max(50, service.rps + Math.floor((Math.random() - 0.5) * 60));
    service.lastUpdated = timestamp;

    if (Math.random() > 0.98) {
      service.status = service.status === 'healthy' ? 'degraded' : 'healthy';
    }

    const sequence = (serviceSequences.get(service.id) ?? 0) + 1;
    serviceSequences.set(service.id, sequence);
    const event: MetricEvent = {
      offset: ++globalOffset,
      serviceId: service.id,
      sequence,
      timestamp,
      service: { ...service }
    };

    updatedServices.push(service);
    events.push(event);
    eventHistory.push(event);

    const history = serviceHistory.get(service.id) ?? [];
    history.push(toHistoryPoint(service, timestamp));
    if (history.length > MAX_SERVICE_HISTORY) history.shift();
    serviceHistory.set(service.id, history);
  }

  if (eventHistory.length > MAX_EVENT_HISTORY) {
    eventHistory.splice(0, eventHistory.length - MAX_EVENT_HISTORY);
  }

  return { updatedServices, events, timestamp };
}

// Kept for callers that only need the list of changed services.
export function updateRandomServices(): Microservice[] {
  return updateMetrics().updatedServices;
}

function toHistoryPoint(service: Microservice, timestamp: number): MetricHistoryPoint {
  return {
    timestamp,
    timeLabel: new Date(timestamp).toTimeString().split(' ')[0],
    p95: service.p95,
    errRate: service.errRate,
    rps: service.rps
  };
}
