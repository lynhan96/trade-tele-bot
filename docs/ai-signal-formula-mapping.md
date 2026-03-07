# AI Signal System — Final Solution

> **Last updated**: 2026-03-07
> **Status**: FULLY IMPLEMENTED — all 8 strategies live in production.

## Core Philosophy

**AI does NOT trade. AI is a regime detector + parameter selector.**

The existing formulas (F1-F8) in `bot-signal` are battle-tested signal machines.
The AI system's job: run those same machines **inside binance-tele-bot**, but with
**per-coin, per-regime tuned parameters** instead of one global config for all coins.

```
bot-signal (legacy):     1 config --> 200 coins --> same params for everyone
AI system (current):     50 hot coins --> AI reads each coin --> picks best formula + tunes params
                         --> pipe-delimited fallbacks (e.g. "F4|F2") --> tries each until signal
```

---

## Complete Formula Analysis (All 8 Strategies)

### F1 — TREND_EMA: Trend EMA Cross
**Type**: Trend-following
**Indicators**: EMA(9) x EMA(21), optional EMA200 on higher TF, **ADX strength filter**
**Signal**:
- Fast EMA crosses above Slow EMA --> LONG
- Fast EMA crosses below Slow EMA --> SHORT
- Optional gate: skip if price is farther than `trendRange`% from EMA200 on HTF
- **ADX filter**: Skip if ADX < threshold (weak trend)

**Params**: `fastEma` (9), `slowEma` (21), `trendKline`, `trendRange` (%), `enableTrendGate`
**Best regime**: STRONG_TREND, STRONG_BULL, STRONG_BEAR
**Weakness**: Whipsaw in ranging markets --> ADX filter helps

---

### F2 — MEAN_REVERT_RSI: EMA200 + RSI Mean Reversion
**Type**: Mean reversion
**Indicators**: EMA(200), RSI(14), **ADX < 30**, **bounce candle confirmation**
**Signal**:
- Price > EMA200 AND RSI < longRSI (30) AND price within `priceRange`% of EMA --> LONG
- Price < EMA200 AND RSI > shortRSI (70) AND price within `priceRange`% of EMA --> SHORT
- **ADX must be < 30** (ranging, not trending)
- **Bounce candle**: Requires a reversal candle pattern for confirmation

**Params**: `emaPeriod` (200), `longRsi`, `shortRsi`, `priceRange` (%), `enableCandleRun`
**Best regime**: RANGE_BOUND, price near key EMA level
**Weakness**: Fails in strong trends (RSI stays extreme)

---

### F3 — BB_CORRELATION: BTC BB --> ALT BB Correlation
**Type**: Market correlation (2-stage)
**Indicators**: Bollinger Bands(20,2) on BTC --> Bollinger Bands(20,2) on ALT
**Stage 1 (BTC)**:
- BTC green candle near upper BB --> store SHORT signal state
- BTC red candle near lower BB --> store LONG signal state
**Stage 2 (ALT)**:
- When BTC signal confirmed --> find ALTs near their own BB band

**Params**: `btcKline`, `btcRange`, `btcNumberCandle`, `altKline`, `altRange`
**Best regime**: BTC_CORRELATION
**Note**: Monitors BTC, not the ALT itself. Unique among all formulas.

---

### F4 — STOCH_BB_PATTERN: Stochastic + BB + 3-Candle Reversal
**Type**: Reversal (2-stage stateful)
**Indicators**: Bollinger Bands(20,2), Stochastic or StochRSI, optional RSI trend
**Stage 1 (pattern detection)**:
- LONG: RED-GREEN-RED candle pattern AND price within `rangeCondition_1`% of lower BB
- SHORT: GREEN-RED-GREEN pattern AND price within `rangeCondition_1`% of upper BB
- Store state in Redis: `{isLong, count: 1}`

**Stage 2 (stochastic confirmation)**:
- Wait up to `numberCheckCandle` candles
- LONG: Stoch %K crosses above %D AND %D < `stochLong` (30)
- SHORT: Stoch %K crosses below %D AND %D > `stochShort` (70)

**Params**: `kLength`, `smoothingK`, `smoothingD`, `stochLong`, `stochShort`, `numberCheckCandle`, `rangeCondition1`, `rangeCondition2`
**Needs**: OHLC data (HIGH and LOW for Stochastic)
**Best regime**: RANGE_BOUND, price bouncing within BB bands

---

### F5 — STOCH_EMA_KDJ: Stochastic Cross + EMA Body Cross + KDJ
**Type**: Momentum entry (2-stage stateful)
**Indicators**: Stochastic or StochRSI, EMA(period), optional KDJ, optional EMA trend
**Stage 1 (Stoch cross in extreme zone)**:
- LONG: Stoch %K crosses above %D AND %D < `stochLong`
- SHORT: Stoch %K crosses below %D AND %D > `stochShort`
- Store state in Redis immediately

**Stage 2 (EMA body cross)**:
- Candle body straddles the EMA (EMA between open and close)
- LONG: green candle + more body above EMA
- SHORT: red candle + more body below EMA
- Optional: KDJ confirmation (J crosses D in extreme zone)

**Params**: `ema`, `kLength`, `smoothingK/D`, `stochLong/Short`, `minRange`, `maxRange`, KDJ params
**Needs**: OHLC data
**Best regime**: VOLATILE/MOMENTUM

---

### F8c2 — RSI_CROSS: RSI Cross RSI-EMA
**Type**: RSI-based momentum
**Signal**:
- RSI crosses above RSI-EMA AND RSI < threshold --> LONG
- RSI crosses below RSI-EMA AND RSI > threshold --> SHORT
- Optional: HTF RSI confirmation (RSI > RSI-EMA on higher TF)
- Optional: candle direction gate

**Params**: `rsiPeriod` (14), `rsiEmaPeriod` (9), `rsiThreshold` (50), `enableHtfRsi`, `htfKline`
**Best regime**: STRONG_TREND, MIXED
**Note**: Most production-ready, proven F8 logic

---

### F8c3 — RSI_ZONE: RSI Overbought/Oversold Zones
**Type**: RSI reversal
**Signal**:
- RSI < rsiBottom (30) --> LONG (oversold)
- RSI > rsiTop (70) --> SHORT (overbought)
- Optional: initial candle direction, HTF RSI confirmation

**Params**: `rsiPeriod` (14), `rsiTop` (70), `rsiBottom` (30), `enableInitialCandle`, `enableHtfRsi`
**Best regime**: VOLATILE, clear extremes

---

### NEW — EMA_PULLBACK: Trend Pullback to EMA21
**Type**: Trend pullback entry
**Indicators**: EMA21, trend direction, HTF RSI
**Signal**:
- **LONG**: Price dips to EMA21 during bull trend (price was above, touches/pierces EMA21, bounces)
- **SHORT**: Price rallies to EMA21 during bear trend (price was below, touches EMA21, rejected)
- HTF RSI check confirms trend direction

**Params**: `emaPeriod` (21), HTF RSI settings
**Best regime**: STRONG_TREND (buying dips in uptrend, selling rallies in downtrend)
**Note**: New strategy not from original F1-F8, added based on production performance gaps

---

### NEW — BB_SCALP: Bollinger Band Bounce Scalp
**Type**: BB band bounce scalp
**Indicators**: Bollinger Bands, RSI (deep oversold/overbought), candle body %
**Signal**:
- **LONG**: Price at lower BB + RSI < 35 (deep oversold) + sufficient candle body % + HTF RSI
- **SHORT**: Price at upper BB + RSI > 65 + sufficient body % + HTF RSI

**Params**: BB period/stddev, RSI threshold (35 for long, 65 for short), min body %, HTF settings
**Best regime**: RANGE_BOUND, SIDEWAYS (scalping BB boundaries)
**Note**: New strategy for sideways markets where STOCH_BB_PATTERN doesn't trigger (no 3-candle pattern needed)

---

## Strategy Selection (AI Pipe-Delimited Fallback)

AI now returns pipe-delimited strategies (e.g. `"STOCH_BB_PATTERN|MEAN_REVERT_RSI"`).
The rule engine tries each in order until one fires a signal.

```
Is bbWidth > 5%?
  YES --> Is volumeRatio > 2x?
    YES --> VOLATILE --> RSI_ZONE | STOCH_EMA_KDJ
    NO  --> VOLATILE --> STOCH_EMA_KDJ | BB_SCALP

  NO --> Is emaTrend BULLISH or BEARISH?
    YES --> Is ADX > 25? (confirmed trend)
      YES --> STRONG_TREND --> TREND_EMA | EMA_PULLBACK
      NO  --> Weak trend --> RSI_CROSS | EMA_PULLBACK

    NO (MIXED) --> Is bbWidth < 2%?
      YES --> RANGE_BOUND --> STOCH_BB_PATTERN | BB_SCALP
      NO  --> RANGE_BOUND --> MEAN_REVERT_RSI | RSI_ZONE

  Special: BTC at BB extreme AND ALT correlates?
    --> BTC_CORRELATION --> BB_CORRELATION
```

---

## AiTunedParams Interface (Current)

```typescript
interface AiTunedParams {
  symbol: string;
  regime: 'STRONG_BULL' | 'STRONG_BEAR' | 'RANGE_BOUND' | 'SIDEWAYS' |
          'VOLATILE' | 'BTC_CORRELATION' | 'MIXED';
  strategy: string;           // pipe-delimited: "STOCH_BB_PATTERN|MEAN_REVERT_RSI"
  confidence: number;         // 0-100
  minConfidenceToTrade: number;
  timeframeProfile: 'INTRADAY' | 'SWING';

  // Strategy-specific params (only chosen strategy's block populated)
  trendEma?: { ... };
  meanRevertRsi?: { ... };
  bbCorrelation?: { ... };
  stochBbPattern?: { ... };
  stochEmaKdj?: { ... };
  rsiCross?: { ... };
  rsiZone?: { ... };
  emaPullback?: { ... };     // NEW
  bbScalp?: { ... };         // NEW

  // Common
  stopLossPercent: number;    // 7-15% (dynamic, AI-tuned)
  takeProfitPercent: number;  // 1.5x-3x SL (based on regime/volatility)
  updatedAt: number;
}
```

---

## Redis Cache Keys (Complete)

| Key | TTL | Content | Writer |
|---|---|---|---|
| `candle-close-price:{COIN}:{interval}` | by interval | Close prices[] | MarketDataService |
| `candle-open-price:{COIN}:{interval}` | by interval | Open prices[] | MarketDataService |
| `candle-high-price:{COIN}:{interval}` | by interval | High prices[] | MarketDataService |
| `candle-low-price:{COIN}:{interval}` | by interval | Low prices[] | MarketDataService |
| `cache:market:scan` | 5 min | All futures tickers | MarketDataService |
| `cache:filter:shortlist` | 6 min | FilteredCoin[] (composite scored) | CoinFilterService |
| `cache:ai:params:{symbol}` | 2h + jitter | AiTunedParams | AiOptimizerService |
| `cache:ai:regime` | 10 min | Market regime | AiOptimizerService |
| `cache:ai:call_count:{hour}` | 1h | Number (rate limit) | AiOptimizerService |
| `cache:ai-signal:active:{signalKey}` | 24h / 72h | Signal ID (profile-aware) | SignalQueueService |
| `cache:ai-signal:queued:{signalKey}` | 4h / 48h | Signal ID (profile-aware) | SignalQueueService |
| `cache:ai-signal:state:{symbol}:{strategy}` | 48h | 2-stage state | RuleEngineService |
| `cache:ai-signal:lastSignal:{symbol}` | 1h | Dedup direction+time | RuleEngineService |

---

## Implementation Status

All phases are **COMPLETE** and running in production:

- [x] Phase 0 — Foundation: Data pipeline, candle cache, MongoDB
- [x] Phase 1 — RSI_CROSS + RSI_ZONE (F8 logic)
- [x] Phase 2 — TREND_EMA + MEAN_REVERT_RSI (F1, F2)
- [x] Phase 3 — STOCH_BB_PATTERN (F4, 2-stage)
- [x] Phase 4 — STOCH_EMA_KDJ (F5, 2-stage + KDJ)
- [x] Phase 5 — AI Optimizer live (Haiku/GPT waterfall)
- [x] Phase 6 — EMA_PULLBACK + BB_SCALP (new strategies)
- [x] Phase 7 — Real trading (UserRealTradingService)
- [x] Phase 8 — Position monitoring + trailing stops
- [x] Phase 9 — Dual timeframe (INTRADAY/SWING)
- [x] Phase 10 — Health monitoring + market cooldown
- [x] Phase 11 — Telegram commands (15+ /ai commands)
- [x] Phase 12 — User data streams (WebSocket order fills)
- [x] Phase 13 — Futures analytics + composite coin scoring
