import fs from 'fs'
import path from 'path'
import { logger } from '../utils/logger.js'

const PM2_LOGS_DIR = process.env.PM2_LOGS_DIR || '/home/ubuntu/.pm2/logs'
const PROC = process.env.PM2_PROCESS_NAME || 'trade-tele-bot'
const lastPos = {}

function readNew(filePath) {
  try {
    if (!fs.existsSync(filePath)) return ''
    const stat = fs.statSync(filePath)
    const from = lastPos[filePath] ?? Math.max(0, stat.size - 30000)
    if (stat.size <= from) { lastPos[filePath] = stat.size; return '' }
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(stat.size - from)
    fs.readSync(fd, buf, 0, buf.length, from)
    fs.closeSync(fd)
    lastPos[filePath] = stat.size
    return buf.toString('utf8')
  } catch { return '' }
}

export function collectLogs() {
  return {
    stderr: readNew(path.join(PM2_LOGS_DIR, `${PROC}-error.log`)),
    stdout: readNew(path.join(PM2_LOGS_DIR, `${PROC}-out.log`)),
    processName: PROC
  }
}

export function hasAnomalies(logs) {
  const patterns = [
    /uncaughtexception/i, /unhandledrejection/i,
    /ECONNREFUSED/i, /EADDRINUSE/i, /out of memory/i,
    /crashed/i, /killed/i, /fatal/i, /SIGKILL/i,
    /Cannot find module/i, /TypeError.*undefined/i,
    /MongoServerError/i, /ETIMEOUT/i
  ]
  const text = (logs.stderr || '') + (logs.stdout || '')
  return patterns.some(r => r.test(text))
}
