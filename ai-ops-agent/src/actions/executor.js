import { execSync } from 'child_process'
import { logger } from '../utils/logger.js'

const nvm = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && '
const PROC = () => process.env.PM2_PROCESS_NAME || 'trade-tele-bot'

export function run(cmd, cwd) {
  logger.info(`▶ ${cmd}`)
  try {
    const out = execSync(`${nvm}${cmd}`, { cwd, encoding: 'utf8', timeout: 120000 })
    return { ok: true, output: out }
  } catch (err) {
    logger.error(`✗ ${cmd}: ${err.message}`)
    return { ok: false, error: err.message }
  }
}

export const restartBot = () => run(`pm2 restart ${PROC()}`)
export const getBotStatus = () => run(`pm2 jlist`)
export const getBotLogs = (n = 50) => run(`pm2 logs ${PROC()} --lines ${n} --nostream`)

export function getCurrentCommit() {
  try {
    return {
      hash: execSync('git rev-parse HEAD', { cwd: process.env.APP_ROOT, encoding: 'utf8' }).trim().slice(0, 8),
      msg: execSync('git log -1 --pretty=%s', { cwd: process.env.APP_ROOT, encoding: 'utf8' }).trim()
    }
  } catch { return { hash: '?', msg: '?' } }
}
