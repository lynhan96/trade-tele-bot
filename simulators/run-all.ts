/**
 * Master Simulator Runner
 * Runs all test suites: order-refactor, hedge, bugfix
 * Run: npx ts-node simulators/run-all.ts
 */
import { execSync } from 'child_process';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const simDir = __dirname;
const suites = [
  { name: 'Order-Based Refactor', file: 'run-order-refactor-simulator.ts' },
  { name: 'Hedge System', file: 'run-hedge-simulator.ts' },
  { name: 'Bug Fix & Edge Cases', file: 'run-bugfix-simulator.ts' },
];

let totalPassed = 0;
let totalFailed = 0;
const results: { name: string; passed: number; failed: number; ok: boolean }[] = [];

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║          MASTER SIMULATOR — ALL SUITES              ║');
console.log('╚══════════════════════════════════════════════════════╝\n');

for (const suite of suites) {
  const filePath = path.join(simDir, suite.file);
  console.log(`\n${'━'.repeat(56)}`);
  console.log(`▶ ${suite.name} (${suite.file})`);
  console.log('━'.repeat(56));

  try {
    const output = execSync(`npx ts-node "${filePath}"`, {
      cwd: root,
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(output);

    // Parse results from last line matching "N passed, N failed"
    const match = output.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
    const passed = match ? parseInt(match[1]) : 0;
    const failed = match ? parseInt(match[2]) : 0;
    totalPassed += passed;
    totalFailed += failed;
    results.push({ name: suite.name, passed, failed, ok: failed === 0 });
  } catch (err: any) {
    const output = (err.stdout || '') + (err.stderr || '');
    console.log(output);
    const match = output.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
    const passed = match ? parseInt(match[1]) : 0;
    const failed = match ? parseInt(match[2]) : 1;
    totalPassed += passed;
    totalFailed += failed;
    results.push({ name: suite.name, passed, failed, ok: false });
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(56));
console.log('SUMMARY');
console.log('═'.repeat(56));
for (const r of results) {
  const icon = r.ok ? '✅' : '❌';
  console.log(`  ${icon} ${r.name}: ${r.passed} passed, ${r.failed} failed`);
}
console.log('─'.repeat(56));
console.log(`  TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
console.log('═'.repeat(56));

process.exit(totalFailed > 0 ? 1 : 0);
