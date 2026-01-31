#!/usr/bin/env ts-node

import { ReentrySafetySimulator } from "./src/simulator/reentry-safety.simulator";

console.log("🎯 Re-entry Safety System - Test Simulator");
console.log("==========================================\n");

const simulator = new ReentrySafetySimulator();
const results = simulator.runAllTests();

process.exit(results.failed > 0 ? 1 : 0);
