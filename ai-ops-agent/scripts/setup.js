#!/usr/bin/env node
import 'dotenv/config'
import axios from 'axios'
import { MongoClient } from 'mongodb'

let allOk = true
const ok   = n => console.log(`✅ ${n}`)
const fail = (n, r) => { console.log(`❌ ${n}: ${r}`); allOk = false }

console.log('\n🤖 AI Ops Agent — Setup Validation\n' + '='.repeat(40))

// Env vars
console.log('\n📋 Environment:')
for (const k of ['ANTHROPIC_API_KEY','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','MONGODB_URI','APP_ROOT','PM2_PROCESS_NAME']) {
  process.env[k] ? ok(k) : fail(k, 'Missing')
}

// APIs
console.log('\n🔌 APIs:')
try {
  await axios.post('https://api.anthropic.com/v1/messages',
    { model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  )
  ok('Anthropic API')
} catch (e) { fail('Anthropic', e.response?.data?.error?.message || e.message) }

try {
  const r = await axios.get(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`)
  ok(`Telegram (@${r.data.result?.username})`)
} catch (e) { fail('Telegram', e.message) }

try {
  const client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  const count = await client.db().collection('ai_signals').countDocuments()
  ok(`MongoDB (${count} signals)`)
  await client.close()
} catch (e) { fail('MongoDB', e.message) }

console.log('\n' + '='.repeat(40))
if (allOk) {
  console.log('✅ All checks passed!\n   pm2 start ecosystem.config.cjs && pm2 save')
} else {
  console.log('❌ Fix issues above before starting.')
  process.exit(1)
}
