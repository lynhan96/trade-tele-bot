#!/usr/bin/env ts-node

/**
 * Unified Test Runner
 * Runs all simulators in sequence and provides comprehensive results
 */

import { CompleteSystemSimulator } from "./src/simulator/complete-system.simulator";
import { ReentrySafetySimulator } from "./src/simulator/reentry-safety.simulator";
import { SkillsSimulator } from "./src/simulator/skills.simulator";

interface SimulatorResult {
  name: string;
  total: number;
  passed: number;
  failed: number;
  successRate: number;
}

function printHeader() {
  console.log("\n" + "═".repeat(80));
  console.log("🎯 UNIFIED TEST SUITE - ALL SIMULATORS");
  console.log("═".repeat(80));
  console.log("\nRunning comprehensive tests for:");
  console.log("  1️⃣  Complete System (TP, SL, Re-entry Flow)");
  console.log("  2️⃣  Re-entry Safety (Market Conditions, EMA, Volume)");
  console.log("  3️⃣  Skills & Features (Commands, API, Data Storage)");
  console.log("\n" + "═".repeat(80) + "\n");
}

function printSimulatorHeader(number: number, name: string) {
  console.log("\n" + "━".repeat(80));
  console.log(`${number}️⃣  ${name.toUpperCase()}`);
  console.log("━".repeat(80));
}

function printSeparator() {
  console.log("\n" + "━".repeat(80) + "\n");
}

function printFinalSummary(results: SimulatorResult[]) {
  console.log("\n" + "═".repeat(80));
  console.log("📊 FINAL TEST SUMMARY");
  console.log("═".repeat(80) + "\n");

  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;

  results.forEach((result) => {
    const status = result.failed === 0 ? "✅" : "⚠️";
    console.log(`${status} ${result.name}`);
    console.log(
      `   Tests: ${result.total} | Passed: ${result.passed} | Failed: ${result.failed} | Success: ${result.successRate.toFixed(1)}%`,
    );

    totalTests += result.total;
    totalPassed += result.passed;
    totalFailed += result.failed;
  });

  const overallSuccess = (totalPassed / totalTests) * 100;

  console.log("\n" + "─".repeat(80));
  console.log("📈 OVERALL RESULTS");
  console.log("─".repeat(80));
  console.log(`Total Tests:    ${totalTests}`);
  console.log(`✅ Passed:      ${totalPassed}`);
  console.log(`❌ Failed:      ${totalFailed}`);
  console.log(`📊 Success:     ${overallSuccess.toFixed(1)}%`);
  console.log("═".repeat(80));

  if (overallSuccess === 100) {
    console.log("\n🎉 ALL TESTS PASSED! System is fully validated.\n");
  } else if (overallSuccess >= 80) {
    console.log("\n✅ Most tests passed. Minor issues detected.\n");
  } else if (overallSuccess >= 60) {
    console.log("\n⚠️  Several tests failed. Review required.\n");
  } else {
    console.log("\n❌ Major issues detected. Immediate action required.\n");
  }
}

async function runAllSimulators() {
  printHeader();

  const results: SimulatorResult[] = [];

  try {
    // 1. Complete System Simulator
    printSimulatorHeader(1, "Complete System Simulator");
    const completeSystem = new CompleteSystemSimulator();
    const completeResults = completeSystem.runAllTests();
    results.push({
      name: "Complete System",
      total: completeResults.total,
      passed: completeResults.passed,
      failed: completeResults.failed,
      successRate: (completeResults.passed / completeResults.total) * 100,
    });

    printSeparator();

    // 2. Re-entry Safety Simulator
    printSimulatorHeader(2, "Re-entry Safety Simulator");
    const safetySimulator = new ReentrySafetySimulator();
    const safetyResults = safetySimulator.runAllTests();
    results.push({
      name: "Re-entry Safety",
      total: safetyResults.total,
      passed: safetyResults.passed,
      failed: safetyResults.failed,
      successRate: (safetyResults.passed / safetyResults.total) * 100,
    });

    printSeparator();

    // 3. Skills Simulator
    printSimulatorHeader(3, "Skills & Features Simulator");
    const skillsSimulator = new SkillsSimulator();
    const skillsResults = skillsSimulator.runAllTests();
    results.push({
      name: "Skills & Features",
      total: skillsResults.total,
      passed: skillsResults.passed,
      failed: skillsResults.failed,
      successRate: (skillsResults.passed / skillsResults.total) * 100,
    });

    // Print final summary
    printFinalSummary(results);

    // Exit with appropriate code
    const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
    process.exit(totalFailed > 0 ? 1 : 0);
  } catch (error) {
    console.error("\n❌ Fatal error running simulators:");
    console.error(error);
    process.exit(1);
  }
}

// Run all simulators
runAllSimulators();
