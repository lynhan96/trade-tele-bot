import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { logger } from "./logger.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEMORY_DIR = path.join(__dirname, "../../memory")
const DECISIONS_FILE = path.join(MEMORY_DIR, "decisions.json")
const LEARNINGS_FILE = path.join(MEMORY_DIR, "learnings.json")
const MAX_DECISIONS = 100
const MAX_LEARNINGS = 50

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) }
  catch { return [] }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8")
}

// ── Decisions: what agent decided and outcome ──
export function saveDecision(decision) {
  const decisions = readJSON(DECISIONS_FILE)
  decisions.unshift({ ...decision, timestamp: new Date().toISOString() })
  if (decisions.length > MAX_DECISIONS) decisions.length = MAX_DECISIONS
  writeJSON(DECISIONS_FILE, decisions)
  logger.info(`[Memory] Saved decision: ${decision.action}`)
}

export function getRecentDecisions(n = 20) {
  return readJSON(DECISIONS_FILE).slice(0, n)
}

// ── Learnings: patterns agent discovered ──
export function saveLearning(learning) {
  const learnings = readJSON(LEARNINGS_FILE)
  // Dedup by key
  const idx = learnings.findIndex(l => l.key === learning.key)
  if (idx >= 0) {
    learnings[idx] = { ...learning, updatedAt: new Date().toISOString(), count: (learnings[idx].count || 1) + 1 }
  } else {
    learnings.unshift({ ...learning, createdAt: new Date().toISOString(), count: 1 })
  }
  if (learnings.length > MAX_LEARNINGS) learnings.length = MAX_LEARNINGS
  writeJSON(LEARNINGS_FILE, learnings)
}

export function getLearnings() {
  return readJSON(LEARNINGS_FILE)
}

// ── Build context for Claude ──
export function buildMemoryContext() {
  const decisions = getRecentDecisions(10)
  const learnings = getLearnings().slice(0, 10)
  const parts = []
  if (decisions.length) {
    parts.push("=== RECENT DECISIONS (learn from outcomes) ===")
    decisions.forEach(d => {
      parts.push(`[${d.timestamp?.slice(0,16)}] ${d.action} → ${d.outcome || "pending"} | ${d.reason}`)
    })
  }
  if (learnings.length) {
    parts.push("\n=== LEARNINGS (patterns discovered) ===")
    learnings.forEach(l => {
      parts.push(`[${l.key}] ${l.insight} (seen ${l.count}x)`)
    })
  }
  return parts.join("\n")
}
