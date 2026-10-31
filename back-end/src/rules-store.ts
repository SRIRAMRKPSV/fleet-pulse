import { AlertRule } from './models';
import { createDefaultRules } from './dummy-data';
import { v4 as uuidv4 } from 'uuid';

// ============================================================
// In-memory store for alert rules
// ============================================================
let rules: AlertRule[] = createDefaultRules();

// ============================================================
// getAll() - returns all rules
// ============================================================
export function getAll(): AlertRule[] {
  return rules;
}

// ============================================================
// getById() - returns one rule by id
// ============================================================
export function getById(id: string): AlertRule | undefined {
  return rules.find(r => r.id === id);
}

// ============================================================
// create() - adds a new rule
// ============================================================
export function create(data: Omit<AlertRule, 'id' | 'createdAt'>): AlertRule {
  const newRule: AlertRule = {
    ...data,
    id: uuidv4(),
    createdAt: new Date().toISOString()
  };
  rules.push(newRule);
  return newRule;
}

// ============================================================
// update() - edits an existing rule by id
// ============================================================
export function update(
  id: string,
  data: Partial<Omit<AlertRule, 'id' | 'createdAt'>>
): AlertRule | null {
  const index = rules.findIndex(r => r.id === id);
  if (index === -1) return null;

  rules[index] = { ...rules[index], ...data, id };
  return rules[index];
}

// ============================================================
// remove() - deletes a rule by id
// ============================================================
export function remove(id: string): boolean {
  const before = rules.length;
  rules = rules.filter(r => r.id !== id);
  return rules.length < before; // true if something was deleted
}
