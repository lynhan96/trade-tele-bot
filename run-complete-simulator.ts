#!/usr/bin/env ts-node

import { CompleteSystemSimulator } from "./src/simulator/complete-system.simulator";

console.log("🎯 Complete Trading System - Test Simulator");
console.log("============================================\n");
console.log("Testing all functions:");
console.log("  • TP Target Checking");
console.log("  • Profit Filtering (>2%)");
console.log("  • Stop Loss Calculation");
console.log("  • Re-entry Data Storage");
console.log("  • Complete Flow Integration");
console.log("  • Multiple Retry Cycles\n");

const simulator = new CompleteSystemSimulator();
const results = simulator.runAllTests();

process.exit(results.failed > 0 ? 1 : 0);
