/**
 * Shared test utilities for all simulators
 */

export interface TestResult {
  total: number;
  passed: number;
  failed: number;
}

export function runTest(
  results: TestResult,
  name: string,
  fn: () => void,
): void {
  results.total++;
  try {
    fn();
    results.passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    results.failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     → ${err.message}`);
  }
}

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export function assertClose(
  actual: number,
  expected: number,
  tolerance: number,
  message: string,
): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${message}: expected ${expected} ± ${tolerance}, got ${actual}`,
    );
  }
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected "${expected}", got "${actual}"`);
  }
}

export function assertNotNull<T>(val: T | null | undefined, message: string): void {
  if (val === null || val === undefined) {
    throw new Error(`${message}: expected non-null, got ${val}`);
  }
}
