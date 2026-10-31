// Simple status types for each microservice
export type ServiceStatus = 'healthy' | 'degraded' | 'down';

// Represents one microservice in the fleet
export interface Microservice {
  id: string;            // e.g. "svc-0001"
  name: string;          // e.g. "payments-api"
  team: string;          // e.g. "payments"
  status: ServiceStatus; // 'healthy', 'degraded', or 'down'
  p95: number;           // 95th percentile latency in milliseconds
  errRate: number;       // error rate percentage (0 to 100%)
  rps: number;           // requests per second
  lastUpdated: number;   // timestamp of last update
  isFlashing?: boolean;  // true for 1 second when status changes (visual flash)
}

// Columns we can sort by
export type SortColumn = 'name' | 'team' | 'status' | 'p95' | 'errRate' | 'rps';
export type SortDirection = 'asc' | 'desc';
