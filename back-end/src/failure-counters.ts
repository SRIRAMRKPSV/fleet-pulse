const failures = new Map<string, number>();

export function recordFailure(name: string): void {
  failures.set(name, (failures.get(name) ?? 0) + 1);
}

export function getFailureCounts(): Record<string, number> {
  return Object.fromEntries(failures);
}
