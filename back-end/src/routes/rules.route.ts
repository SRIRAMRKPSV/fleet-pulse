import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { AlertRule, RuleCondition } from '../models';
import * as RulesStore from '../rules-store';
import { authMiddleware, operatorOnly } from '../auth-middleware';

const router = Router();
const idempotencyCache = new Map<string, { ruleId: string; fingerprint: string; expiresAt: number }>();
const mutableFields = new Set(['name', 'warningThreshold', 'criticalThreshold', 'conditions', 'enabled']);

function cleanExpiredIdempotencyKeys(): void {
  const now = Date.now();
  for (const [key, value] of idempotencyCache) {
    if (now >= value.expiresAt) idempotencyCache.delete(key);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRuleFields(
  value: unknown,
  existing?: AlertRule
): { fields?: Omit<AlertRule, 'id' | 'createdAt'>; error?: string } {
  if (!isObject(value)) return { error: 'Request body must be a JSON object' };

  const keys = Object.keys(value);
  if (keys.some(key => !mutableFields.has(key))) {
    return { error: 'Only name, warningThreshold, criticalThreshold, conditions and enabled may be changed' };
  }
  if (existing && keys.length === 0) return { error: 'At least one rule field must be provided' };

  const name = value['name'] === undefined ? existing?.name : value['name'];
  const warningThreshold = value['warningThreshold'] === undefined
    ? (existing?.warningThreshold ?? 0)
    : value['warningThreshold'];
  const criticalThreshold = value['criticalThreshold'] === undefined
    ? existing?.criticalThreshold
    : value['criticalThreshold'];
  const conditions = value['conditions'] === undefined ? existing?.conditions : value['conditions'];
  const enabled = value['enabled'] === undefined ? (existing?.enabled ?? true) : value['enabled'];

  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    return { error: 'name must be a non-empty string of at most 100 characters' };
  }
  if (typeof warningThreshold !== 'number' || !Number.isFinite(warningThreshold) || warningThreshold < 0) {
    return { error: 'warningThreshold must be a non-negative number' };
  }
  if (typeof criticalThreshold !== 'number' || !Number.isFinite(criticalThreshold) || criticalThreshold < 0) {
    return { error: 'criticalThreshold must be a non-negative number' };
  }
  if (warningThreshold > criticalThreshold) {
    return { error: 'warningThreshold cannot exceed criticalThreshold' };
  }
  if (!Array.isArray(conditions) || conditions.length === 0 || conditions.length > 20) {
    return { error: 'conditions must contain between 1 and 20 conditions' };
  }
  const parsedConditions: RuleCondition[] = [];
  for (const condition of conditions) {
    if (!isObject(condition)
      || !['p95', 'errRate', 'rps'].includes(String(condition['metric']))
      || !['>', '>=', '<', '<='].includes(String(condition['operator']))
      || typeof condition['threshold'] !== 'number'
      || !Number.isFinite(condition['threshold'])
      || condition['threshold'] < 0
      || typeof condition['durationSec'] !== 'number'
      || !Number.isFinite(condition['durationSec'])
      || condition['durationSec'] < 0) {
      return {
        error: 'Each condition needs metric (p95, errRate or rps), operator, non-negative threshold and durationSec'
      };
    }
    parsedConditions.push({
      metric: condition['metric'] as RuleCondition['metric'],
      operator: condition['operator'] as RuleCondition['operator'],
      threshold: condition['threshold'],
      durationSec: condition['durationSec']
    });
  }
  if (typeof enabled !== 'boolean') return { error: 'enabled must be a boolean' };

  return {
    fields: {
      name: name.trim(),
      warningThreshold,
      criticalThreshold,
      conditions: parsedConditions,
      enabled
    }
  };
}

router.get('/', authMiddleware, (_req: Request, res: Response) => {
  res.json({ success: true, data: RulesStore.getAll() });
});

router.get('/check-name', authMiddleware, (req: Request, res: Response) => {
  const rawName = req.query['name'];
  const rawExcludeId = req.query['excludeId'];
  const name = typeof rawName === 'string' ? rawName.trim().toLowerCase() : '';
  const excludeId = typeof rawExcludeId === 'string' ? rawExcludeId : '';
  const conflict = RulesStore.getAll().find(
    rule => rule.id !== excludeId && rule.name.trim().toLowerCase() === name
  );
  res.json({ success: true, available: !conflict });
});

router.get('/:id', authMiddleware, (req: Request, res: Response) => {
  const rule = RulesStore.getById(req.params.id);
  if (!rule) {
    res.status(404).json({ success: false, message: 'Rule not found' });
    return;
  }
  res.json({ success: true, data: rule });
});

router.post('/', authMiddleware, operatorOnly, (req: Request, res: Response) => {
  cleanExpiredIdempotencyKeys();
  const parsed = parseRuleFields(req.body);
  if (!parsed.fields) {
    res.status(400).json({ success: false, message: parsed.error });
    return;
  }

  const idempotencyHeader = req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'];
  const key = typeof idempotencyHeader === 'string' ? idempotencyHeader.trim() : undefined;
  if (idempotencyHeader !== undefined && (!key || key.length > 200)) {
    res.status(400).json({ success: false, message: 'Idempotency-Key must be 1 to 200 characters' });
    return;
  }
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(parsed.fields)).digest('hex');
  if (key) {
    const cached = idempotencyCache.get(key);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        res.status(409).json({ success: false, message: 'Idempotency-Key was already used with a different request' });
        return;
      }
      const rule = RulesStore.getById(cached.ruleId);
      if (rule) {
        res.status(200).json({ success: true, data: rule, idempotent: true });
        return;
      }
      idempotencyCache.delete(key);
    }
  }

  const duplicate = RulesStore.getAll().find(
    rule => rule.name.toLowerCase() === parsed.fields?.name.toLowerCase()
  );
  if (duplicate) {
    res.status(409).json({ success: false, message: 'A rule with that name already exists' });
    return;
  }

  const newRule = RulesStore.create(parsed.fields);
  if (key) {
    idempotencyCache.set(key, {
      ruleId: newRule.id,
      fingerprint,
      expiresAt: Date.now() + 600_000
    });
  }
  res.status(201).json({ success: true, data: newRule });
});

router.put('/:id', authMiddleware, operatorOnly, (req: Request, res: Response) => {
  const existing = RulesStore.getById(req.params.id);
  if (!existing) {
    res.status(404).json({ success: false, message: 'Rule not found' });
    return;
  }

  const parsed = parseRuleFields(req.body, existing);
  if (!parsed.fields) {
    res.status(400).json({ success: false, message: parsed.error });
    return;
  }

  const duplicate = RulesStore.getAll().find(
    rule => rule.id !== existing.id && rule.name.toLowerCase() === parsed.fields?.name.toLowerCase()
  );
  if (duplicate) {
    res.status(409).json({ success: false, message: 'A rule with that name already exists' });
    return;
  }

  const updated = RulesStore.update(existing.id, parsed.fields);
  if (!updated) {
    res.status(404).json({ success: false, message: 'Rule not found' });
    return;
  }
  res.json({ success: true, data: updated });
});

router.delete('/:id', authMiddleware, operatorOnly, (req: Request, res: Response) => {
  if (!RulesStore.remove(req.params.id)) {
    res.status(404).json({ success: false, message: 'Rule not found' });
    return;
  }
  res.json({ success: true, message: 'Rule deleted' });
});

export default router;
