#!/usr/bin/env ts-node

import { SkillsSimulator } from "./src/simulator/skills.simulator";

console.log("🎯 Skills & Features - Test Simulator");
console.log("======================================\n");
console.log("Testing bot skills:");
console.log("  • Command Parsing");
console.log("  • Exchange Detection");
console.log("  • TP Configuration");
console.log("  • Retry Configuration");
console.log("  • Position Closing");
console.log("  • Redis Data Structures");
console.log("  • API Error Handling");
console.log("  • Notification Formatting\n");

const simulator = new SkillsSimulator();
const results = simulator.runAllTests();

process.exit(results.failed > 0 ? 1 : 0);
