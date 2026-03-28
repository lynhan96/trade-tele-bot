---
name: check-logs
description: Check real-time server logs for errors, trades, hedge events. Use when debugging issues or monitoring bot activity.
---

# Check Server Logs

## Quick commands (all via SSH)

### Recent bot logs (last 50 lines)
```bash
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 logs trade-tele-bot --lines 50 --nostream"
```

### Filter by keyword
```bash
# Errors only
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 logs trade-tele-bot --lines 500 --nostream 2>&1" | grep -i "error\|fail\|WARN"

# Specific symbol (e.g. BARDUSDT)
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 logs trade-tele-bot --lines 500 --nostream 2>&1" | grep -i "BARD" | grep -iv "debug\|Grid\|RSI\|CoinFilter\|MarketData"

# Trade opens/closes
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 logs trade-tele-bot --lines 500 --nostream 2>&1" | grep -iE "REAL order placed|closeRealPosition|FLIP|Lenh Da Dong|onTradeClose"

# Hedge events
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 logs trade-tele-bot --lines 500 --nostream 2>&1" | grep -iE "hedge.*open|hedge.*close|HEDGE_TP|HEDGE_TRAIL|OrphanHedge|FLIP"

# Trail SL on Binance
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 logs trade-tele-bot --lines 500 --nostream 2>&1" | grep -iE "trail SL placed|trail.*breach|trail.*OK"

# Grid DCA fills
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 logs trade-tele-bot --lines 500 --nostream 2>&1" | grep -iE "Grid.*filled|Grid.*DCA|placeGridOrder"

# SL/TP placement
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 logs trade-tele-bot --lines 500 --nostream 2>&1" | grep -iE "SL missing|TP missing|SL.*placed|TP.*placed|protectOpenTrades"

# Agent config changes
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 logs ai-ops-agent --lines 100 --nostream 2>&1" | grep -iE "AutoConfig|CLAMP|UPDATE_CONFIG"

# Desync detection
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 logs trade-tele-bot --lines 500 --nostream 2>&1" | grep -iE "BINANCE_CLOSED|position gone|DESYNC|synced"
```

### Live tail (follow mode)
```bash
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 logs trade-tele-bot --lines 10"
# Ctrl+C to stop
```

### Agent logs
```bash
ssh ubuntu@171.244.48.10 "source ~/.nvm/nvm.sh && pm2 logs ai-ops-agent --lines 30 --nostream"
```

## Common patterns to look for
- `ERROR` / `WARN` — bugs or API failures
- `closeRealPosition: SKIPPED` — syncedFromBinance grace period
- `CIRCUIT BREAKER` — progressive SL triggered
- `FLIP` — main TP + hedge kept as new main
- `trail SL placed on Binance` — trail protection active
- `AutoConfig` — agent changed config
- `CLAMP` — agent tried destructive value, got clamped
