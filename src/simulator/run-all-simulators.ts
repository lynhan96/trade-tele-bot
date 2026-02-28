/**
 * Run All Simulators
 * Aggregates results from every simulator and prints a combined report.
 * Run with: npx ts-node src/simulator/run-all-simulators.ts
 */

import { CompleteSystemSimulator } from "./complete-system.simulator";
import { ReentrySafetySimulator } from "./reentry-safety.simulator";
import { SkillsSimulator } from "./skills.simulator";
import { ServiceStructureSimulator } from "./service-structure.simulator";
import { StrategyIndicatorsSimulator } from "./strategy-indicators.simulator";
import { AiSignalQueueSimulator } from "./ai-signal-queue.simulator";

interface SimulatorResult {
  name: string;
  total: number;
  passed: number;
  failed: number;
}

async function runAll(): Promise<void> {
  const results: SimulatorResult[] = [];

  console.log("\n" + "=".repeat(80));
  console.log("🤖 BINANCE-TELE-BOT — FULL TEST SUITE");
  console.log("=".repeat(80));

  // 1. Complete System (TP math, profit filter, SL calc, re-entry flow)
  console.log("\n▶ Running: Complete System Simulator");
  const completeResult = new CompleteSystemSimulator().runAllTests();
  results.push({ name: "Complete System", ...completeResult });

  // 2. Re-entry Safety (cooldown, price range, EMA, volume pressure)
  console.log("\n▶ Running: Re-entry Safety Simulator");
  const reentryResult = new ReentrySafetySimulator().runAllTests();
  results.push({ name: "Re-entry Safety", ...reentryResult });

  // 3. Skills (command parsing, exchange detection, Redis key structure)
  console.log("\n▶ Running: Skills Simulator");
  const skillsResult = new SkillsSimulator().runAllTests();
  results.push({ name: "Skills", ...skillsResult });

  // 4. Service Structure (refactored service logic patterns)
  console.log("\n▶ Running: Service Structure Simulator");
  const structureResult = new ServiceStructureSimulator().runAllTests();
  results.push({ name: "Service Structure", ...structureResult });

  // 5. Strategy Indicators (RSI, EMA, Stoch, KDJ, ATR, rule engine, 2-stage FSM)
  console.log("\n▶ Running: Strategy Indicators Simulator");
  const strategyResult = new StrategyIndicatorsSimulator().runAllTests();
  results.push({ name: "Strategy Indicators", ...strategyResult });

  // 6. AI Signal Queue (state machine, PnL, TTL, stop loss, win rate)
  console.log("\n▶ Running: AI Signal Queue Simulator");
  const aiQueueResult = new AiSignalQueueSimulator().runAllTests();
  results.push({ name: "AI Signal Queue", ...aiQueueResult });

  // ── Combined Summary ───────────────────────────────────────────────────────
  const totalAll = results.reduce((s, r) => s + r.total, 0);
  const passedAll = results.reduce((s, r) => s + r.passed, 0);
  const failedAll = results.reduce((s, r) => s + r.failed, 0);

  console.log("\n" + "=".repeat(80));
  console.log("📊 COMBINED TEST RESULTS");
  console.log("=".repeat(80));

  for (const r of results) {
    const rate = r.total > 0 ? ((r.passed / r.total) * 100).toFixed(0) : "0";
    const icon = r.failed === 0 ? "✅" : "❌";
    console.log(
      `  ${icon} ${r.name.padEnd(25)} ${r.passed}/${r.total} (${rate}%)`,
    );
  }

  console.log("─".repeat(80));
  const overallRate =
    totalAll > 0 ? ((passedAll / totalAll) * 100).toFixed(1) : "0";
  console.log(
    `  ${"TOTAL".padEnd(25)} ${passedAll}/${totalAll} (${overallRate}%)`,
  );

  if (failedAll === 0) {
    console.log("\n🎉 All tests passed!\n");
  } else {
    console.log(`\n⚠️  ${failedAll} test(s) failed — review output above.\n`);
  }

  process.exit(failedAll > 0 ? 1 : 0);
}

runAll().catch((err) => {
  console.error("Fatal error running simulators:", err);
  process.exit(1);
});
