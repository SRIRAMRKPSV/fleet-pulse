export type MetricType = 'p95' | 'errRate' | 'rps';
export type OperatorType = '>' | '>=' | '<' | '<=';

// One condition in an alert rule
export interface RuleCondition {
  metric: MetricType;       // 'p95' | 'errRate' | 'rps'
  operator: OperatorType;   // '>' | '>=' | '<' | '<='
  threshold: number;        // e.g. 500
  durationSec: number;      // e.g. 30
}

// An alert rule created by an operator
export interface AlertRule {
  id: string;
  name: string;
  warningThreshold?: number;
  criticalThreshold?: number;
  conditions: RuleCondition[];
  enabled: boolean;
  createdAt: string;
}
