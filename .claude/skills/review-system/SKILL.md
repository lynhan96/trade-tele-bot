---
name: review-system
description: Full system health check — compare Binance vs DB, check agent, config, PnL stats. Use when user asks to "review", "check system", or "health check".
---

# System Review Checklist

Run this comprehensive check via SSH:

```bash
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && cd ~/projects/binance-tele-bot && node -e \"
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const https = require('https');
require('dotenv').config();
function sign(qs, s) { return crypto.createHmac('sha256', s).update(qs).digest('hex'); }
function bGet(p, k, s) { return new Promise((ok, no) => { const t=Date.now(); const q='timestamp='+t; const u='https://fapi.binance.com'+p+'?'+q+'&signature='+sign(q,s); https.get(u,{headers:{'X-MBX-APIKEY':k}},(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{ok(JSON.parse(d))}catch(e){no(e)}})}).on('error',no)})}
(async()=>{
  const c=new MongoClient(process.env.MONGODB_URI); await c.connect(); const db=c.db();
  // 1. Config
  const redis=require('redis').createClient({url:'redis://localhost:6379',database:2}); await redis.connect();
  const cfg=JSON.parse(await redis.get('binance-telebot:trading-config')||'{}');
  console.log('CONFIG:', JSON.stringify(cfg));
  // 2. Open trades
  const trades=await db.collection('user_trades').find({status:'OPEN'}).toArray();
  console.log('\\nOPEN TRADES:', trades.length);
  for(const t of trades) console.log(t.symbol,t.direction,t.isHedge?'HEDGE':'MAIN','entry='+t.entryPrice?.toFixed(6),'sl='+t.slPrice,'slAlgo='+(t.binanceSlAlgoId||'NONE'));
  // 3. Binance positions
  const sub=await db.collection('user_signal_subscriptions').findOne({realModeEnabled:true});
  const set=await db.collection('user_settings').findOne({telegramId:sub?.telegramId});
  if(set?.binance){const pos=await bGet('/fapi/v2/positionRisk',set.binance.apiKey,set.binance.apiSecret);
  const op=pos.filter(p=>Math.abs(parseFloat(p.positionAmt))>0);
  console.log('\\nBINANCE:', op.length, 'positions');
  for(const p of op){const e=parseFloat(p.entryPrice),m=parseFloat(p.markPrice),q=parseFloat(p.positionAmt),d=q>0?'LONG':'SHORT';
  console.log(p.symbol,d,'entry='+e,'mark='+m,'pnl='+(d==='LONG'?((m-e)/e*100):((e-m)/e*100)).toFixed(2)+'%');}
  // 4. Desync check
  const dbSymDirs=new Set(trades.map(t=>t.symbol+':'+t.direction));
  const bnSymDirs=new Set(op.map(p=>p.symbol+':'+(parseFloat(p.positionAmt)>0?'LONG':'SHORT')));
  for(const k of bnSymDirs) if(!dbSymDirs.has(k)) console.log('DESYNC: '+k+' on Binance but NOT in DB');
  for(const k of dbSymDirs) if(!bnSymDirs.has(k)) console.log('DESYNC: '+k+' in DB but NOT on Binance');}
  // 5. 7-day stats
  const s7=new Date(Date.now()-7*86400000);
  const mc=await db.collection('user_trades').find({status:'CLOSED',closedAt:{$gte:s7},isHedge:{$ne:true}}).toArray();
  const hc=await db.collection('user_trades').find({status:'CLOSED',closedAt:{$gte:s7},isHedge:true}).toArray();
  const mw=mc.filter(t=>(t.pnlUsdt||0)>0).length;
  console.log('\\n7-DAY: main='+mc.length+'('+mw+'W) pnl='+mc.reduce((s,t)=>s+(t.pnlUsdt||0),0).toFixed(2)+' | hedge='+hc.length+' pnl='+hc.reduce((s,t)=>s+(t.pnlUsdt||0),0).toFixed(2));
  // 6. Agent
  console.log('\\nAGENT: check pm2 logs ai-ops-agent');
  await redis.quit(); await c.close();
})()\"" 2>&1
```

## What to check
1. **CONFIG** — any undefined fields? hedgeTrigger >= 2?
2. **DESYNC** — positions on Binance not in DB (or vice versa)
3. **SL ALGO** — every OPEN trade must have slAlgoId (not NONE)
4. **7-DAY PnL** — trending positive?
5. **Agent** — running and auto-configuring?
