// ============================================================
// Microservice model
// Every service has these fields
// ============================================================
export interface Microservice {
  id: string;
  name: string;
  team: string;
  status: 'healthy' | 'degraded' | 'down';
  p95: number;        // latency in ms
  errRate: number;    // error percentage
  rps: number;        // requests per second
  lastUpdated: number; // timestamp
}

// ============================================================
// Alert Rule model
// ============================================================
export interface RuleCondition {
  metric: 'p95' | 'errRate' | 'rps';
  operator: '>' | '>=' | '<' | '<=';
  threshold: number;
  durationSec: number;
}

export type UserRole = 'viewer' | 'operator';

export interface AlertRule {
  id: string;
  name: string;
  warningThreshold: number;
  criticalThreshold: number;
  conditions: RuleCondition[];
  enabled: boolean;
  createdAt: string;
}

// ============================================================
// WebSocket message shape
// The server sends this to the frontend every 500ms
// ============================================================
export interface StreamUpdate {
  type: 'metrics-update';
  updatedServices: Microservice[]; // only the changed ones
  timestamp: number;
  offset?: number; // global stream sequence number (Phase 3)
  events?: MetricEvent[];
  snapshot?: boolean;
  replayFrom?: number;
  sequences?: Record<string, number>;
}

export interface MetricEvent {
  offset: number;
  serviceId: string;
  sequence: number;
  timestamp: number;
  service: Microservice;
}
