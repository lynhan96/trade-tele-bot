# AI Signal Module

Core trading module. All trading logic lives here.

## Service Map

| Service | File | Role |
|---------|------|------|
| AiSignalService | ai-signal.service.ts | Cron scanner: CoinFilter → Strategy → Signal creation |
| PositionMonitorService | position-monitor.service.ts | Price tick handler: TP/SL/Trail/Grid/Hedge for SIM |
| UserRealTradingService | user-real-trading.service.ts | Real Binance orders: mirrors sim logic |
| HedgeManagerService | hedge-manager.service.ts | Hedge entry/exit decisions (pure logic, no side effects) |
| SignalQueueService | signal-queue.service.ts | Signal lifecycle (queue/activate/resolve) |
| UserDataStreamService | user-data-stream.service.ts | Binance WebSocket: ORDER_TRADE_UPDATE events |
| TradingConfigService | trading-config.ts | Config with defaults + Redis override + hard floors |

## Critical Rules

1. **SIM + Real must use identical logic** — no real-only gates/filters
2. **onTradeClose must filter by direction** — prevent hedge close from closing main
3. **Grid DCA fixed**: L0=0%(40%), L1=2%(15%), L2=4%(15%), L3=6%(30%)
4. **hedgeTrigger >= 2%** enforced in TradingConfig.get()
5. **Trail SL must be placed on Binance** (not just backend check)
6. **HedgePositionContext** decouples hedge logic from signal document
7. **Order cache invalidation** after any write to orders collection

## Data Flow: Price Tick

```
MarketData WebSocket → price event
  → PositionMonitorService.handlePriceTick(signal, price)
    → Load mainOrder + hedgeOrder from DB (cached 5s)
    → Grid DCA check (fill pending levels)
    → If hedge enabled:
      → realHedgeCallback (independent, fires every tick)
      → If !hedgeActive: checkHedge → open if PnL < -trigger%
      → If hedgeActive: checkHedgeExit → close if TP/trail/recovery
      → NET_POSITIVE check (banked + unrealized > 2% filledVol)
    → TP/SL check (with fresh mainOrder reload)
    → Trail stop (move SL to lock profit)
```

## Data Flow: Real Trade Close

```
Binance ORDER_TRADE_UPDATE (FILLED, reduce-only)
  → UserDataStreamService.handleEvent
    → Derive closedDirection from order.S (BUY→SHORT closed, SELL→LONG closed)
    → onTradeClose(symbol, price, reason, closedDirection)
      → findOne({ symbol, direction: closedDirection, status: "OPEN" })
      → Update trade with PnL, cancel remaining algo orders
```
