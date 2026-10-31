// Represents a single point of time on the chart
export interface MetricPoint {
  timeLabel: string; // e.g. "14:32:05"
  p95: number;       // latency ms
  errRate: number;   // error rate %
  rps: number;       // throughput
}

// A live stream update received from the server (or dummy generator)
export interface MetricEvent {
  serviceId: string;
  p95: number;
  errRate: number;
  rps: number;
  status: 'healthy' | 'degraded' | 'down';
  timestamp: number;
}
