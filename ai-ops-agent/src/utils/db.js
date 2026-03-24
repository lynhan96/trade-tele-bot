import { MongoClient } from 'mongodb'
import { logger } from './logger.js'

let client = null
let db = null

export async function getDb() {
  if (db) return db
  client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  db = client.db()
  logger.info('MongoDB connected')
  return db
}

export async function closeDb() {
  if (client) await client.close()
}
