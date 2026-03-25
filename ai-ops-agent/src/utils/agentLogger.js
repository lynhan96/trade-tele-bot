import axios from "axios"
import { logger } from "./logger.js"

const BASE = process.env.HEALTH_URL?.replace("/admin/health", "") || "http://127.0.0.1:3001"

// Log agent events to MongoDB via admin API (for dashboard)
export async function logAgentEvent(event) {
  try {
    const payload = {
      type: event.type || "THOUGHT",
      agent: event.agent || "active_trader",
      message: event.message || "",
      details: event.details || "",
      data: event.data || {},
      status: event.status || "done",
      symbol: event.symbol || "",
      actionType: event.actionType || "",
      outcome: event.outcome || {},
    }
    await axios.post(`${BASE}/admin/agent/events`, payload, { timeout: 5000 })
  } catch (err) {
    logger.error(`[AgentLog] POST failed: ${err.response?.status || err.code || err.message} | agent=${event.agent} msg=${(event.message || "").slice(0, 60)}`)
  }
}

// Shortcuts
export const thought = (agent, message, data) =>
  logAgentEvent({ type: "THOUGHT", agent, message, status: "thinking", data })

export const decision = (agent, message, data) =>
  logAgentEvent({ type: "DECISION", agent, message, status: "acting", data })

export const action = (agent, message, actionType, symbol, outcome) =>
  logAgentEvent({ type: "ACTION", agent, message, status: "done", actionType, symbol, outcome })

export const learning = (agent, message, data) =>
  logAgentEvent({ type: "LEARNING", agent, message, status: "done", data })

export const error = (agent, message, data) =>
  logAgentEvent({ type: "ERROR", agent, message, status: "error", data })

export const report = (agent, message, data) =>
  logAgentEvent({ type: "REPORT", agent, message, status: "done", data })
