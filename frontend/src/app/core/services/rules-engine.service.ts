import { DestroyRef, effect, Injectable, inject, signal, untracked } from '@angular/core';
import { AlertRule, OperatorType } from '../models/rule.model';
import { MetricsStreamService } from './metrics-stream.service';
import { AuthService } from './auth.service';
import { ApiClientService } from './api-client.service';
import { Observable, catchError, from, map, of, switchMap, throwError, timer } from 'rxjs';

const isTestEnv = typeof process !== 'undefined' &&
  (Boolean(process.env['VITEST']) || process.env['NODE_ENV'] === 'test');

export function conditionMatches(value: number, operator: OperatorType, threshold: number): boolean {
  switch (operator) {
    case '>': return value > threshold;
    case '>=': return value >= threshold;
    case '<': return value < threshold;
    case '<=': return value <= threshold;
  }
}

@Injectable({
  providedIn: 'root'
})
export class RulesEngineService {
  private stream = inject(MetricsStreamService);
  private auth = inject(AuthService);
  private api = inject(ApiClientService);
  private destroyRef = inject(DestroyRef);

  // All rules are loaded from Backend API (No hardcoded sample data)
  rules = signal<AlertRule[]>([]);

  // Incidents raised when rules fire (Requirement D8)
  incidents = signal<{
    id: string;
    ruleName: string;
    serviceName: string;
    metric: string;
    value: number;
    threshold: number;
    time: string;
  }[]>([]);

  // Toast notification message
  currentNotification = signal<string | null>(null);

  // Deduplication tracker so the same incident doesn't fire twice
  private activeIncidentKeys = new Set<string>();
  private evaluationTimer: ReturnType<typeof setInterval>;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly conditionSince = new Map<string, number>();
  private readonly conditionDurationTimerMs = 500;
  private rulesLoadPromise: Promise<void> | null = null;

  constructor() {
    this.evaluationTimer = setInterval(() => this.evaluateRules(), this.conditionDurationTimerMs);
    this.destroyRef.onDestroy(() => {
      clearInterval(this.evaluationTimer);
      if (this.toastTimer) clearTimeout(this.toastTimer);
    });

    effect(() => {
      if (!this.auth.isAuthenticated()) {
        this.rules.set([]);
        this.activeIncidentKeys.clear();
        this.conditionSince.clear();
        return;
      }

      untracked(() => void this.loadRulesFromBackend());
    });
  }

  /**
   * Load alert rules from backend API
   */
  async loadRulesFromBackend(): Promise<void> {
    if (!this.auth.isAuthenticated() || isTestEnv || typeof fetch === 'undefined') return;
    if (this.rulesLoadPromise) return this.rulesLoadPromise;

    this.rulesLoadPromise = (async () => {
      try {
        const response = await this.api.request('rules');
        if (!response.ok) throw new Error(`Request failed (${response.status}).`);
        const body = await response.json();
        if (!Array.isArray(body?.data)) throw new Error('The rules response did not contain a data array.');
        if (!this.auth.isAuthenticated()) return;
        this.rules.set(body.data);
      } catch (error) {
        console.error('Could not load alert rules from backend:', error);
        this.showToast('Could not load alert rules. Check the connection and retry.');
      } finally {
        this.rulesLoadPromise = null;
      }
    })();
    return this.rulesLoadPromise;
  }

  evaluateRules(now = Date.now()): void {
    const activeKeys = new Set<string>();
    const matchingConditionKeys = new Set<string>();
    for (const rule of this.rules().filter(item => item.enabled)) {
      for (const service of this.stream.services()) {
        const ruleServiceKey = `${rule.id}-${service.id}`;
        const matchingConditions = rule.conditions
          .map((condition, index) => ({ condition, index }))
          .filter(({ condition }) => {
          const value = service[condition.metric];
          return conditionMatches(value, condition.operator, condition.threshold);
        });
        if (matchingConditions.length === 0) continue;

        activeKeys.add(ruleServiceKey);
        let firedCondition: AlertRule['conditions'][number] | undefined;
        for (const { condition, index } of matchingConditions) {
          const conditionKey = `${ruleServiceKey}-${index}`;
          matchingConditionKeys.add(conditionKey);
          const since = this.conditionSince.get(conditionKey) ?? now;
          this.conditionSince.set(conditionKey, since);
          if (now - since >= condition.durationSec * 1000 && !firedCondition) {
            firedCondition = condition;
          }
        }
        if (!firedCondition || this.activeIncidentKeys.has(ruleServiceKey)) continue;
        this.activeIncidentKeys.add(ruleServiceKey);
        this.incidents.update(list => [{
          id: `inc-${now}-${list.length}`,
          ruleName: rule.name,
          serviceName: service.name,
          metric: firedCondition.metric,
          value: service[firedCondition.metric],
          threshold: firedCondition.threshold,
          time: new Date(now).toLocaleTimeString()
        }, ...list].slice(0, 50));
        this.showToast(`Alert fired: ${rule.name} on ${service.name}`);
      }
    }

    for (const key of this.conditionSince.keys()) {
      if (!matchingConditionKeys.has(key)) this.conditionSince.delete(key);
    }
    for (const key of this.activeIncidentKeys) {
      if (!activeKeys.has(key)) this.activeIncidentKeys.delete(key);
    }
  }

  showToast(message: string): void {
    this.currentNotification.set(message);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      if (this.currentNotification() === message) {
        this.currentNotification.set(null);
      }
    }, 4500);
  }

  async saveRule(newRule: AlertRule): Promise<boolean> {
    const existingIndex = this.rules().findIndex(r => r.id === newRule.id);

    if (existingIndex >= 0) {
      const previous = this.rules()[existingIndex];
      this.rules.update(list => list.map(r => r.id === newRule.id ? newRule : r));
      try {
        const response = await this.api.request(`rules/${encodeURIComponent(newRule.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newRule)
        });
        await this.ensureSuccess(response, 'update rule');
        const body = await response.json();
        if (!this.isAlertRule(body?.data)) throw new Error('The update response did not contain a valid rule.');
        this.rules.update(list => list.map(rule => rule.id === newRule.id ? body.data : rule));
        this.showToast(`Rule "${newRule.name}" updated.`);
        return true;
      } catch (error) {
        this.rules.update(list => list.map(rule => rule.id === newRule.id ? previous : rule));
        this.reportOperationError('update rule', error);
        return false;
      }
    } else {
      this.rules.update(list => [newRule, ...list]);
      try {
        const response = await this.api.request('rules', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID()
          },
          body: JSON.stringify(newRule)
        });
        await this.ensureSuccess(response, 'create rule');
        const body = await response.json();
        if (!this.isAlertRule(body?.data)) throw new Error('The create response did not contain a valid rule.');
        this.rules.update(list => list.map(rule => rule.id === newRule.id ? body.data : rule));
        this.showToast(`Rule "${newRule.name}" created.`);
        return true;
      } catch (error) {
        this.rules.update(list => list.filter(rule => rule.id !== newRule.id));
        this.reportOperationError('create rule', error);
        return false;
      }
    }
  }

  async deleteRule(id: string): Promise<boolean> {
    const previousIndex = this.rules().findIndex(rule => rule.id === id);
    const previous = this.rules()[previousIndex];
    if (!previous) return false;
    this.rules.update(list => list.filter(r => r.id !== id));

    try {
      const response = await this.api.request(`rules/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      await this.ensureSuccess(response, 'delete rule');
      this.showToast('Rule deleted.');
      return true;
    } catch (error) {
      this.rules.update(list => {
        if (list.some(rule => rule.id === id)) return list;
        const restored = [...list];
        restored.splice(Math.min(previousIndex, restored.length), 0, previous);
        return restored;
      });
      this.reportOperationError('delete rule', error);
      return false;
    }
  }

  async toggleRule(id: string): Promise<boolean> {
    const current = this.rules().find(r => r.id === id);
    if (!current) return false;
    const updated = { ...current, enabled: !current.enabled };
    this.rules.update(list => list.map(r => r.id === id ? updated : r));
    try {
      const response = await this.api.request(`rules/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
      await this.ensureSuccess(response, 'toggle rule');
      return true;
    } catch (error) {
      this.rules.update(list => list.map(rule => rule.id === id ? current : rule));
      this.reportOperationError('toggle rule', error);
      return false;
    }
  }

  checkNameAvailable(name: string, excludeId?: string): boolean {
    const clean = name.trim().toLowerCase();
    return !this.rules().some(r => r.id !== excludeId && r.name.toLowerCase() === clean);
  }

  checkNameAvailableRemotely(name: string, excludeId?: string): Observable<boolean> {
    if (!this.checkNameAvailable(name, excludeId)) return of(false);
    const query = new URLSearchParams({ name: name.trim() });
    if (excludeId) query.set('excludeId', excludeId);

    return timer(300).pipe(
      switchMap(() => from(this.api.request(`rules/check-name?${query.toString()}`))),
      switchMap(response => {
        if (!response.ok) return throwError(() => new Error(`Name check failed (${response.status}).`));
        return from(response.json());
      }),
      map(body => {
        if (typeof body?.available !== 'boolean') {
          throw new Error('The name-check response did not include availability.');
        }
        return body.available;
      }),
      catchError(error => {
        console.error('Could not validate rule-name availability:', error);
        return of(false);
      })
    );
  }

  private async ensureSuccess(response: Response, action: string): Promise<void> {
    if (response.ok) return;
    let message = `Could not ${action}: request failed (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body?.message === 'string' && body.message.trim()) message = body.message;
    } catch (error) {
      console.warn(`Could not read the backend error response while attempting to ${action}:`, error);
    }
    throw new Error(message);
  }

  private reportOperationError(action: string, error: unknown): void {
    console.error(`Could not ${action}:`, error);
    this.showToast(error instanceof Error ? error.message : `Could not ${action}.`);
  }

  private isAlertRule(value: unknown): value is AlertRule {
    if (!value || typeof value !== 'object') return false;
    const rule = value as Partial<AlertRule>;
    return typeof rule.id === 'string' &&
      typeof rule.name === 'string' &&
      typeof rule.enabled === 'boolean' &&
      Array.isArray(rule.conditions);
  }
}
