---
name: hedge-analysis
description: Analyze hedge system performance — recovery ratio, cycle efficiency, per-coin stats. Use when user asks about hedge performance, wants to tune hedge params, or review hedge history.
---

# Hedge Analysis

## Query hedge performance
```bash
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && cd ~/projects/binance-tele-bot && node -e \"
const { MongoClient } = require('mongodb');
require('dotenv').config();
(async()=>{
  const c=new MongoClient(process.env.MONGODB_URI); await c.connect(); const db=c.db();

  // All completed signals with hedge history
  const sigs=await db.collection('ai_signals').find({status:'COMPLETED','hedgeHistory.0':{\\\$exists:true}}).sort({positionClosedAt:-1}).limit(20).toArray();
  console.log('=== HEDGE PERFORMANCE (last 20 hedged signals) ===');
  for(const s of sigs){
    const hh=s.hedgeHistory||[];
    const banked=hh.reduce((sum,h)=>sum+(h.pnlUsdt||0),0);
    const mainPnl=s.pnlUsdt||0;
    const cycles=hh.length;
    const winCycles=hh.filter(h=>(h.pnlUsdt||0)>0).length;
    const recovery=Math.abs(mainPnl)>0?Math.abs(banked/mainPnl*100):0;
    console.log(s.symbol,s.direction,'| cycles:'+cycles,'('+winCycles+'W) | banked:\\\$'+banked.toFixed(2),'| mainPnl:\\\$'+mainPnl.toFixed(2),'| recovery:'+recovery.toFixed(0)+'%','|',s.closeReason);
  }

  // Active signals with hedge
  console.log('\\n=== ACTIVE HEDGED ===');
  const active=await db.collection('ai_signals').find({status:'ACTIVE',hedgeActive:true}).toArray();
  for(const s of active){
    console.log(s.symbol,s.direction,'hedgeCycles:'+s.hedgeCycleCount,'hedgeDir:'+s.hedgeDirection,'hedgeEntry:'+s.hedgeEntryPrice);
  }

  await c.close();
})()\""
```

## Key Metrics
- **Recovery ratio**: banked / |mainLoss| — target >= 60%
- **Cycle win rate**: profitable cycles / total — target >= 50%
- **Avg profit per cycle**: banked / cycles — should cover fees ($0.50+)

## Hedge System Architecture
- **Entry**: PnL < -hedgeTrigger% (default 3%, min 2%, max 8%)
- **Exit**: TP hit OR trail stop (activate +2%, keep 70% peak) OR recovery close
- **Progressive SL**: cycle 1-2=40%, cycle 3=15%, cycle 4+=8% (only when recovery<50%)
- **Circuit breaker**: cycle 3+ AND recovery<50% AND price below progressive SL → close all
- **DCA during hedge**: allowed (lowers avgEntry for easier recovery)
- **Real trail**: places actual SL on Binance (not just backend check)

## Config Fields (agent auto-tuned)
- `hedgePartialTriggerPct`: 2-8% (auto by HedgeManager skill, based on volatility)
- `hedgeFullTriggerPct`: same as partial (always go FULL)
- `hedgeTpPct`: TP % for hedge position
- `hedgeMaxCycles`: max cycles per signal (default 7)
