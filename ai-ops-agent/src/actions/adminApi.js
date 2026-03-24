import axios from "axios"
import { logger } from "../utils/logger.js"

const BASE = process.env.HEALTH_URL?.replace("/admin/health", "") || "http://127.0.0.1:3001"
let token = null
let tokenExpiry = 0

async function getToken() {
  if (token && Date.now() < tokenExpiry) return token
  try {
    const { data } = await axios.post(`${BASE}/admin/auth/login`, {
      username: process.env.ADMIN_USER || "admin",
      password: process.env.ADMIN_PASS || "admin123"
    })
    token = data.token
    tokenExpiry = Date.now() + 23 * 3600 * 1000 // 23h
    return token
  } catch (err) {
    logger.error(`[AdminAPI] Login failed: ${err.message}`)
    return null
  }
}

async function api(method, path, data) {
  const t = await getToken()
  if (!t) return null
  try {
    const res = await axios({ method, url: `${BASE}/admin/${path}`, data,
      headers: { Authorization: `Bearer ${t}` }, timeout: 10000 })
    return res.data
  } catch (err) {
    logger.error(`[AdminAPI] ${method} ${path}: ${err.message}`)
    return null
  }
}

// ── Signal Actions ──
export const closeSignal = (id) => api("post", `signals/${id}/close`)
export const closeAllSignals = () => api("post", "signals/close-all")
export const updateSignal = (id, data) => api("patch", `signals/${id}`, data)

// ── Config Actions ──
export const getTradingConfig = () => api("get", "trading-config")
export const updateTradingConfig = (data) => api("patch", "trading-config", data)

// ── Data Queries ──
export const getSignals = (params) => api("get", `signals?${new URLSearchParams(params)}`)
export const getOrders = (params) => api("get", `orders?${new URLSearchParams(params)}`)
export const getDashboard = () => api("get", "dashboard")
