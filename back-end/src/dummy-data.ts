import { Microservice, AlertRule } from './models';
import { v4 as uuidv4 } from 'uuid';

// List of team names
const TEAMS = ['payments', 'checkout', 'identity', 'logistics', 'infra', 'data'];

// List of domain names
const SERVICE_NAMES = [
  'auth', 'payment', 'billing', 'cart', 'order', 'catalog', 'search',
  'notification', 'email', 'sms', 'inventory', 'shipping', 'fraud',
  'analytics', 'reporting', 'gateway', 'router', 'ledger', 'invoice'
];

/**
 * Generates 2,000 microservices (svc-0001 to svc-2000)
 */
export function create2000Services(): Microservice[] {
  const list: Microservice[] = [];
  const now = Date.now();

  for (let i = 1; i <= 2000; i++) {
    const id = 'svc-' + i.toString().padStart(4, '0');
    const baseName = SERVICE_NAMES[(i - 1) % SERVICE_NAMES.length];
    const team = TEAMS[i % TEAMS.length];
    const name = `${baseName}-${i > 19 ? i : 'api'}`;

    let status: 'healthy' | 'degraded' | 'down' = 'healthy';
    if (i % 25 === 0) {
      status = 'degraded';
    } else if (i % 80 === 0) {
      status = 'down';
    }

    const p95 = status === 'healthy' ? 50 + (i % 100) : (status === 'degraded' ? 350 + (i % 200) : 1800);
    const errRate = status === 'healthy' ? +(0.1 + (i % 5) * 0.1).toFixed(2) : (status === 'degraded' ? 4.5 : 55.0);
    const rps = status === 'down' ? 12 : 300 + (i % 1500);

    list.push({
      id,
      name,
      team,
      status,
      p95,
      errRate,
      rps,
      lastUpdated: now
    });
  }

  return list;
}

/**
 * Default alert rules
 */
export function createDefaultRules(): AlertRule[] {
  return [
    {
      id: 'r-1',
      name: 'High Latency Warning',
      warningThreshold: 300,
      criticalThreshold: 500,
      conditions: [
        { metric: 'p95', operator: '>', threshold: 500, durationSec: 10 }
      ],
      enabled: true,
      createdAt: new Date().toISOString()
    },
    {
      id: 'r-2',
      name: 'Checkout High Error Rate',
      warningThreshold: 2,
      criticalThreshold: 5,
      conditions: [
        { metric: 'errRate', operator: '>=', threshold: 5, durationSec: 5 }
      ],
      enabled: true,
      createdAt: new Date().toISOString()
    }
  ];
}
