# AI Signal System — Final Solution

## Core Philosophy

**AI does NOT trade. AI is a regime detector + parameter selector.**

The existing formulas (F1–F8) in `bot-signal` are battle-tested signal machines.
The AI system's job: run those same machines **inside binance-tele-bot**, but with
**per-coin, per-regime tuned parameters** instead of one global config for all coins.

```
bot-signal (current):     1 config → 200 coins → same params for everyone
AI system (new):          10 hot coins → AI reads each coin → picks best formula + tunes params
```

---

## Complete Formula Analysis (All F1–F8)

### F1 — Trend EMA Cross (BOT_FUTURE_CT_1)
**Type**: Trend-following
**Indicators**: EMA(fast) × EMA(slow), optional EMA200 on higher TF
**Signal**:
- Fast EMA crosses above Slow EMA → LONG
- Fast EMA crosses below Slow EMA → SHORT
- Optional gate: skip if price is farther than `trendRange`% from EMA200 on `trendEma200` TF

**Params**: `firstEma` (fast), `secondEma` (slow), `trendEma200` (TF), `trendRange` (%), `time` (dedup hours)
**Best regime**: STRONG_TREND
**Weakness**: Whipsaw in ranging markets → needs trend gate

---

### F2 — EMA200 + RSI Mean Reversion (BOT_FUTURE_CT_2)
**Type**: Mean reversion
**Indicators**: EMA(period), RSI(14), optional EMA200 on higher TF
**Signal**:
- Price > EMA200 AND RSI < longRSI (30) AND price within `priceRange`% of EMA → LONG
- Price < EMA200 AND RSI > shortRSI (70) AND price within `priceRange`% of EMA → SHORT
- Optional: `turnOnCandleRun` — holds signal while candle continues in same direction (entry at candle close)

**Params**: `ema` (EMA period), `longRSI`, `shortRSI`, `priceRange` (%), `trendEma200`, `trendRange`
**Best regime**: RANGE_BOUND, price near key EMA level
**Weakness**: Fails in strong downtrend (RSI can stay oversold for long time)

---

### F3 — BTC BB → ALT BB Correlation (BOT_FUTURE_CT_3)
**Type**: Market correlation (2-stage)
**Indicators**: Bollinger Bands(20,2) on BTC → Bollinger Bands(20,2) on ALT
**Stage 1 (BTC)**:
- BTC green candle near upper BB → store SHORT signal state
- BTC red candle near lower BB → store LONG signal state
- Must hold for `btcNumberCandle` consecutive candles within `btcRange`% of BB
**Stage 2 (ALT)**:
- When BTC signal is confirmed → find ALTs whose price is within `altRange`% of their own BB
- LONG: ALT near lower BB. SHORT: ALT near upper BB.

**Params**: `btcKline`, `btcRange`, `btcNumberCandle`, `altKline`, `altRange`
**Best regime**: BTC_CORRELATION (BTC at BB extreme, alts following)
**Note**: This strategy monitors BTC, not the ALT itself. Unique among all formulas.

---

### F4 — Stochastic + BB + 3-Candle Reversal (BOT_FUTURE_CT_4)
**Type**: Reversal (2-stage stateful)
**Indicators**: Bollinger Bands(20,2), Stochastic or StochRSI, optional RSI trend
**Stage 1 (Condition 1 — pattern detection)**:
- 3-candle reversal pattern near BB:
  - LONG: candles[-3]=RED, candles[-2]=GREEN, candles[-1]=RED (RED-GREEN-RED) AND price within `rangeCondition_1`% of lower BB
  - SHORT: candles[-3]=GREEN, candles[-2]=RED, candles[-1]=GREEN (GREEN-RED-GREEN) AND price within `rangeCondition_1`% of upper BB
- Store state in Redis: `{isLong, count: 1}`

**Stage 2 (Condition 2 — stochastic confirmation)**:
- Wait up to `numberCheckCandle` candles
- LONG: Stoch %K crosses above %D AND %D < `stochLong` (e.g. 30) AND price within `rangeCondition_2`% of BB lower
- SHORT: Stoch %K crosses below %D AND %D > `stochShort` (e.g. 70) AND price within `rangeCondition_2`% of BB upper
- Optional: RSI trend on higher TF (RSI > RSI-EMA → bullish trend → only take LONG)

**Params**: `kLength`, `smoothingK`, `smoothingD`, `stochLong`, `stochShort`, `numberCheckCandle`, `rangeCondition_1`, `rangeCondition_2`, `isTurnOnStochRsi`, `isTurnOnRsiTrend`
**Needs**: OHLC data (not just close — requires HIGH and LOW for Stochastic)
**Best regime**: RANGE_BOUND, price bouncing within BB bands

---

### F5 — Stochastic Cross + EMA Body Cross + KDJ (BOT_FUTURE_CT_5)
**Type**: Momentum entry (2-stage stateful)
**Indicators**: Stochastic or StochRSI, EMA(period), optional KDJ, optional EMA trend
**Stage 1 (Stoch cross in extreme zone)**:
- LONG: Stoch %K or %D crosses above each other AND %D < `stochLong`
- SHORT: Stoch %K or %D crosses below each other AND %D > `stochShort`
- Store state in Redis immediately, then re-run signal check on same candle

**Stage 2 (EMA body cross)**:
- Candle body straddles the EMA (EMA is between open and close)
- Price change within `minRange`%–`maxRange`% of candle body
- LONG: green candle AND EMA inside body AND more body above EMA than below → bullish momentum
- SHORT: red candle AND EMA inside body AND more body below EMA than above → bearish momentum
- Optional: EMA trend filter on higher TF (must be near EMA within `trendRange`%)
- Optional: KDJ confirmation — J crosses D in extreme zone (J < `KDJLongNumber` for LONG)

**Params**: `ema`, `kLength`, `smoothingK`, `smoothingD`, `stochLong`, `stochShort`, `minRange`, `maxRange`, `KDJkLength`, `KDJSmoothingKLength`, `KDJSmoothingDLength`, `KDJSmoothingJLength`, `KDJLongNumber`, `KDJShortNumber`
**Needs**: OHLC data (HIGH and LOW for Stochastic + KDJ)
**Best regime**: VOLATILE/MOMENTUM — catching momentum early via Stochastic + EMA body cross

---

### F6 / F7 — BTC Multi-Indicator → ALT Execution
**Type**: BTC-gated multi-indicator (similar to F3 but with Stoch+EMA+RSI+KDJ on BTC)
**Best regime**: BTC_CORRELATION with momentum confirmation
**Note**: Complex 2-stage BTC filter. Lower priority for AI system — include as enhancement later.

---

### F8 — RSI Cross / RSI Zone (BOT_FUTURE_CT_8) ← ALREADY IN TELE-BOT
**Type**: RSI-based (already proven, already sending to binance-tele-bot via TCP)

**Config 2 — RSI Cross**:
- RSI(rsiPeriod) crosses RSI-EMA(rsiEmaPeriod) on `kline` TF
- LONG: crossedAbove AND (RSI < rsiNumber if threshold enabled)
- SHORT: crossedBelow AND (RSI > rsiNumber if threshold enabled)
- Optional: HTF RSI (`rsiKline`): LONG → HTF RSI > HTF RSI-EMA; SHORT → opposite
- Optional: candle direction (`candleKline`): LONG → currentPrice > lastCandle.open (GREEN)

**Config 3 — RSI Zone**:
- Uses PREVIOUS candle RSI (`excludeLatestCandle=true`)
- LONG: RSI < rsiBottom (oversold). SHORT: RSI > rsiTop (overbought)
- Optional: initial candle direction (same candle close vs open)
- Optional: same HTF RSI and candle direction as Config 2

**Note**: F8 is the most production-ready and has the cleanest code. The AI system builds on top of this.

---

## The Key Missing Insight: Why Current F8 Is Suboptimal

F8 today uses **one global config for ALL coins and ALL market conditions**.

```
Example F8 config today:
  rsiPeriod: 14, rsiNumber: 50, kline: '15m', rsiKline: '1h'
  → Applied to BTCUSDT, ETHUSDT, SOLUSDT, PEPEUSDT equally
```

**The problem**: Different coins have different:
- Volatility cycles (PEPE moves 3× faster than BTC)
- RSI sensitivity (high-cap coins take longer to reach extreme zones)
- Correlation to BTC (some alts are independent)
- Best timeframes for signals

**The AI fix**: Per-coin parameter tuning. The **formula logic stays identical** to what works in production. Only the **inputs** change based on each coin's characteristics.

---

## Market Regime Taxonomy (Properly Defined)

AI assesses regime by computing these indicators first (not sending raw candles):

```typescript
interface RegimeIndicators {
  // EMA alignment
  emaTrend: 'BULLISH' | 'BEARISH' | 'MIXED';
  // price vs EMA20, EMA50, EMA200 on primary TF
  // BULLISH: price > EMA20 > EMA50 > EMA200
  // BEARISH: price < EMA20 < EMA50 < EMA200

  // Bollinger Band width as % of middle band
  bbWidthPct: number;        // < 2% = narrow (ranging), > 4% = wide (volatile)

  // RSI reading
  rsi14: number;             // 0-100

  // Volume vs 20-period average
  volumeRatio: number;       // 1.5 = 50% above average

  // Price momentum
  priceChange24h: number;    // %
  priceChange5d: number;     // %

  // Recent volatility (ATR as % of price, 10-candle)
  atrPct: number;            // 0.5% = low vol, 2%+ = high vol

  // Candle structure (last 3 completed candles)
  lastCandles: Array<{ isGreen: boolean; bodyPct: number; wickPct: number }>;
}
```

**4 Regimes:**

| Regime | Trigger Conditions | Primary Strategy | Backup Strategy |
|---|---|---|---|
| **STRONG_TREND** | emaTrend=BULLISH/BEARISH, bbWidth>3%, atrPct>1%, volumeRatio>1.2 | TREND_EMA (F1) | RSI_CROSS (F8 C2) |
| **RANGE_BOUND** | emaTrend=MIXED, bbWidth<2.5%, RSI 30-70, low atrPct | STOCH_BB_PATTERN (F4) | RSI_ZONE (F8 C3) |
| **VOLATILE** | bbWidth>5%, atrPct>2%, volumeRatio>2, RSI near extremes | RSI_ZONE (F8 C3) | STOCH_EMA_KDJ (F5) |
| **BTC_CORRELATION** | BTC bbWidth>4% and ALT bbWidth>3%, emaTrend same as BTC | BB_CORRELATION (F3) | MEAN_REVERT_RSI (F2) |

---

## Complete AiTunedParams Interface

```typescript
// Redis: cache:ai:params:{symbol} → TTL: 1h (STRONG_TREND) to 4h (RANGE_BOUND)
interface AiTunedParams {
  symbol: string;
  regime: 'STRONG_TREND' | 'RANGE_BOUND' | 'VOLATILE' | 'BTC_CORRELATION';
  strategy: 'TREND_EMA' | 'MEAN_REVERT_RSI' | 'BB_CORRELATION' |
            'STOCH_BB_PATTERN' | 'STOCH_EMA_KDJ' |
            'RSI_CROSS' | 'RSI_ZONE';
  confidence: number;      // 0–100; skip trading if < minConfidenceToTrade
  minConfidenceToTrade: number; // AI decides this based on signal clarity

  // ── Strategy params (only the chosen strategy's block populated) ──

  trendEma?: {
    primaryKline: string;  // '5m' | '15m' | '1h'
    fastEma: number;       // 5 | 9 | 13
    slowEma: number;       // 21 | 34 | 55
    enableTrendGate: boolean;
    trendKline: string;    // '4h' | '1d'
    trendEmaPeriod: number; // 100 | 200
    trendRange: number;    // % — how close to EMA200 price must be
  };

  meanRevertRsi?: {
    primaryKline: string;
    emaPeriod: number;     // 100 | 200
    rsiPeriod: number;     // 14
    longRsi: number;       // 25–35
    shortRsi: number;      // 65–75
    priceRange: number;    // % max distance from EMA to enter
    enableCandleRun: boolean;
    enableTrendGate: boolean;
    trendKline: string;
    trendEmaPeriod: number;
  };

  bbCorrelation?: {
    primaryKline: string;  // ALT timeframe
    bbPeriod: number;      // 20
    bbStdDev: number;      // 2
    altRangePercent: number; // max % from BB band for ALT entry
    // BTC params determined by global ai:regime assessment
  };

  stochBbPattern?: {
    primaryKline: string;  // '15m' | '1h'
    kLength: number;       // 9 | 14
    smoothingK: number;    // 3
    smoothingD: number;    // 3
    stochLong: number;     // 20–30 (%D zone for LONG cross)
    stochShort: number;    // 70–80 (%D zone for SHORT cross)
    bbPeriod: number;      // 20
    bbStdDev: number;      // 2
    rangeCondition1: number; // % — how close to BB for pattern detection
    rangeCondition2: number; // % — how close to BB for stoch confirmation
    numberCheckCandle: number; // 2–5 candles to wait for stoch confirmation
    useStochRsi: boolean;  // false = regular Stoch, true = StochRSI
    enableRsiTrend: boolean;
    trendRsiKline: string; // '1h' | '4h'
    trendRsiPeriod: number; // 14
  };

  stochEmaKdj?: {
    primaryKline: string;
    ema: number;           // 7 | 9 | 21
    kLength: number;
    smoothingK: number;
    smoothingD: number;
    stochLong: number;
    stochShort: number;
    minBodyRange: number;  // % min candle body size
    maxBodyRange: number;  // % max candle body size
    enableTrendGate: boolean;
    trendEma: number;
    trendKline: string;
    trendRange: number;
    enableKdj: boolean;
    KDJkLength: number;
    KDJSmoothingKLength: number;
    KDJSmoothingDLength: number;
    KDJSmoothingJLength: number;
    KDJLongNumber: number; // J zone for LONG (e.g. 20)
    KDJShortNumber: number; // J zone for SHORT (e.g. 80)
  };

  rsiCross?: {
    primaryKline: string;
    rsiPeriod: number;     // 9–21
    rsiEmaPeriod: number;  // 3–9
    enableThreshold: boolean;
    rsiThreshold: number;  // 40–60
    enableHtfRsi: boolean;
    htfKline: string;      // '1h' | '4h'
    enableCandleDir: boolean;
    candleKline: string;
  };

  rsiZone?: {
    primaryKline: string;
    rsiPeriod: number;     // 9–21
    rsiTop: number;        // 65–80
    rsiBottom: number;     // 20–35
    enableInitialCandle: boolean;
    enableHtfRsi: boolean;
    htfKline: string;
    rsiEmaPeriod: number;  // for HTF RSI-EMA comparison
    enableCandleDir: boolean;
    candleKline: string;
  };

  // Common
  stopLossPercent: number;  // 1–3%
  updatedAt: number;        // unix ms
}
```

---

## Redis Cache Keys (Complete)

| Key | TTL | Content | Writer |
|---|---|---|---|
| `candle-close-price:{COIN}:{interval}` | by interval | Close prices[] | MarketDataService (shared with auto-trade) |
| `candle-open-price:{COIN}:{interval}` | by interval | Open prices[] | MarketDataService |
| `candle-high-price:{COIN}:{interval}` | by interval | High prices[] | **NEW** — needed for F4/F5 Stochastic |
| `candle-low-price:{COIN}:{interval}` | by interval | Low prices[] | **NEW** — needed for F4/F5 Stochastic |
| `cache:market:scan` | 5 min | All futures tickers | MarketDataService |
| `cache:filter:shortlist` | 5 min | FilteredCoin[] | CoinFilterService |
| `cache:ai:params:{symbol}` | 1–4h | AiTunedParams | AiOptimizerService |
| `cache:ai:regime` | 4h | Global market regime | AiOptimizerService |
| `cache:ai:call_count:{hour}` | 1h | Number (rate limit) | AiOptimizerService |
| `cache:ai-signal:state:{symbol}:{strategy}` | 48h | 2-stage state | RuleEngineService |
| `cache:ai-signal:lastSignal:{symbol}` | 1h | Last signal direction + time | RuleEngineService (dedup) |

---

## AI Prompt Design (Optimized for Token Cost)

### Haiku Prompt (per symbol, every 1h)
**Token saving**: Pre-compute indicators server-side, send structured summary NOT raw candles.

```
You are a trading strategy parameter optimizer. Analyze this coin and choose the best strategy.

COIN: {symbol}
TIMEFRAME: last 100 candles on 15m, 50 candles on 1h

REGIME INDICATORS (pre-computed):
- EMA trend (15m): {BULLISH | BEARISH | MIXED}
  price={closePrice}, EMA20={ema20}, EMA50={ema50}, EMA200={ema200}
- BB width (15m): {bbWidthPct}% (narrow<2%, normal 2-4%, wide>4%)
- RSI14 (15m): {rsi14}
- Volume ratio (vs 20-avg): {volumeRatio}x
- Price change 24h: {change24h}%
- ATR as % of price (10-candle): {atrPct}%
- Last 3 candles: [{color, bodyPct, wickPct}, ...]
- BTC regime: {btcRegime} (from global cache)

STRATEGY OPTIONS:
1. TREND_EMA — for strong directional moves (EMA cross)
2. MEAN_REVERT_RSI — for ranging near EMA200 with RSI extreme
3. STOCH_BB_PATTERN — for ranging within BB bands (2-stage: candle pattern → stoch cross)
4. STOCH_EMA_KDJ — for momentum entries (stoch cross → EMA body pierce)
5. RSI_CROSS — for RSI-EMA crossovers with optional HTF confirmation
6. RSI_ZONE — for OB/OS reversals with candle/HTF filters

Respond ONLY with valid JSON. No explanation outside JSON (put reasoning in "reasoning" field).
{
  "regime": "STRONG_TREND|RANGE_BOUND|VOLATILE|BTC_CORRELATION",
  "confidence": 0-100,
  "strategy": "<strategy name>",
  "params": { /* strategy-specific fields from the spec */ },
  "stopLossPercent": 1.0-3.0,
  "minConfidenceToTrade": 60-90,
  "reasoning": "<one sentence>"
}
```

**Estimated tokens**: ~350 input, ~200 output = ~550 tokens per call = ~$0.00028 per call
**At 10 coins × 24 hours**: ~$0.067/day — well within budget

### Sonnet Prompt (global market regime, every 4h)
```
Analyze the current crypto market regime based on:

BTC (1h, last 50 candles):
- EMA trend: {trend}, BB width: {bbWidth}%
- RSI: {rsi}, Volume ratio: {volRatio}x

TOP 10 coins by volume — 24h change summary:
{coin}: {change24h}%, vol: ${volume}M
...

Determine: Is the market in STRONG_TREND, RANGE_BOUND, VOLATILE, or BTC_CORRELATION mode?

Respond JSON: {"regime": "...", "confidence": 0-100, "btcOutlook": "bullish|bearish|neutral", "notes": "..."}
```

---

## Signal Flow Architecture (Final)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Binance WebSocket (kline streams for filtered coins)               │
│  Subscribes to: 5m, 15m, 1h for each coin in shortlist             │
│  On each final candle: update candle-close/open/high/low caches     │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                    writes OHLC to Redis
                          │
         ┌────────────────┼──────────────────────┐
         ↓                ↓                      ↓
   close prices[]   high prices[]         low prices[]   open prices[]
   (shared with auto-trade-service if same Redis)
                          │
┌─────────────────────────▼───────────────────────────────────────────┐
│  CoinFilterService (cron: every 5 min)                              │
│  → GET /fapi/v1/ticker/24hr → cache:market:scan                     │
│  → Filter: volume>$50M, priceChange>3%, range>5%                    │
│  → Top 10 coins → cache:filter:shortlist                            │
│  → Notify MarketDataService to update WebSocket subscriptions        │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
         ┌────────────────┼──────────────────────┐
         ↓                                       ↓
┌────────────────────┐                 ┌──────────────────────────────┐
│ AiOptimizerService │                 │ AiSignalService (every 30s)  │
│                    │                 │                              │
│ Haiku (1h/symbol): │                 │ For each coin in shortlist:  │
│  1. Pre-compute    │                 │  1. Get AiTunedParams        │
│     indicators     │                 │  2. Route to rule checker    │
│  2. Send to Haiku  │◄───triggers────►│  3. If signal → execute      │
│  3. Store params   │                 │                              │
│     in Redis       │                 │ → handleIncomingSignal()     │
│                    │                 │                              │
│ Sonnet (4h global):│                 │ 2-stage state managed in     │
│  → market regime   │                 │   Redis per coin per strategy│
│  → cache:ai:regime │                 │                              │
└────────────────────┘                 └──────────────────────────────┘
```

---

## RuleEngineService — Complete Method Signatures

```typescript
// strategy/rules/rule-engine.service.ts

class RuleEngineService {

  // F1 — Trend EMA Cross
  async evalTrendEma(
    params: AiTunedParams['trendEma'],
    coin: string, currency: string, currentPrice: number,
  ): Promise<SignalResult | null>

  // F2 — EMA200 + RSI Mean Reversion
  async evalMeanRevertRsi(
    params: AiTunedParams['meanRevertRsi'],
    coin: string, currency: string, currentPrice: number,
  ): Promise<SignalResult | null>

  // F3 — BB Correlation (ALT side only; BTC state managed separately)
  async evalBbCorrelation(
    params: AiTunedParams['bbCorrelation'],
    coin: string, currency: string, currentPrice: number,
    btcBbState: BtcBbState | null, // from cache:ai:regime or dedicated BTC state
  ): Promise<SignalResult | null>

  // F4 — Stochastic + BB + 3-Candle Pattern (STATEFUL 2-stage)
  async evalStochBbPattern(
    params: AiTunedParams['stochBbPattern'],
    coin: string, currency: string, currentPrice: number,
  ): Promise<SignalResult | null>
  // Internally manages Redis state: cache:ai-signal:state:{symbol}:STOCH_BB

  // F5 — Stochastic + EMA Body Cross + KDJ (STATEFUL 2-stage)
  async evalStochEmaKdj(
    params: AiTunedParams['stochEmaKdj'],
    coin: string, currency: string, currentPrice: number,
  ): Promise<SignalResult | null>
  // Internally manages Redis state: cache:ai-signal:state:{symbol}:STOCH_EMA

  // F8 Config 2 — RSI Cross (port from formula-8.processor.ts checkConfig2)
  async evalRsiCross(
    params: AiTunedParams['rsiCross'],
    coin: string, currency: string, currentPrice: number,
  ): Promise<SignalResult | null>

  // F8 Config 3 — RSI Zone (port from formula-8.processor.ts checkConfig3)
  async evalRsiZone(
    params: AiTunedParams['rsiZone'],
    coin: string, currency: string, currentPrice: number,
  ): Promise<SignalResult | null>
}

interface SignalResult {
  isLong: boolean;
  confidence: number;  // computed from how strongly conditions are met
  strategyUsed: string;
  conditions: Record<string, any>; // log for debugging
}
```

---

## IndicatorService — Extended (add OHLC support)

The existing `indicator.service.ts` only caches close + open.
F4 and F5 require HIGH and LOW for Stochastic and KDJ.

```typescript
// New methods needed in IndicatorService:

async getCandleOhlc(
  coin: string, currency: string, interval: string,
): Promise<{ opens: number[]; highs: number[]; lows: number[]; closes: number[] } | null>
// Redis: candle-high-price:{COIN}:{interval} and candle-low-price:{COIN}:{interval}

async getStochastic(
  coin: string, currency: string, interval: string,
  kLength: number, smoothingK: number, smoothingD: number,
): Promise<{ k: { last: number; secondLast: number }; d: { last: number; secondLast: number } } | null>
// Uses calculateStochastic() from bot-signal/formula/helper.ts (copy as-is)

async getKdj(
  coin: string, currency: string, interval: string,
  options: KdjOptions,
): Promise<{ K: number[]; D: number[]; J: number[] } | null>
// Uses calculateKDJ() from bot-signal/formula/helper.ts (copy as-is)

async getBollingerBands(
  coin: string, currency: string, interval: string,
  period: number, stdDev: number, currentPrice: number,
): Promise<{ upper: number; middle: number; lower: number } | null>
// Uses BollingerBands from technicalindicators (same as F3, F4)
```

**Cache keys to add** (WebSocket handler must store these):
```
candle-high-price:{COIN}:{interval}  →  number[] (highs array)
candle-low-price:{COIN}:{interval}   →  number[] (lows array)
```

---

## Module Structure (Final)

```
binance-tele-bot/src/
├── market-data/
│   ├── market-data.module.ts
│   ├── market-data.service.ts
│   │   - subscribeToKlines(coins: string[], intervals: string[])
│   │   - unsubscribeFromKlines(coins: string[])
│   │   - onKlineUpdate(): saves close/open/HIGH/LOW to Redis
│   │   - startTickerScan(): GET /fapi/v1/ticker/24hr every 5min
│   └── market-data.interfaces.ts
│
├── coin-filter/
│   ├── coin-filter.module.ts
│   ├── coin-filter.service.ts
│   │   - scanAndFilter(): reads cache:market:scan, outputs top 10
│   │   - getShortlist(): returns cache:filter:shortlist
│   └── coin-filter.interfaces.ts   // FilteredCoin { symbol, volume, change24h, range }
│
├── strategy/
│   ├── strategy.module.ts
│   ├── indicators/
│   │   ├── indicator.service.ts    // getRsiWithCross, getCurrentRsi, getLastCandle
│   │   │                          // getLastNCandles, getCandleOhlc, getStochastic
│   │   │                          // getKdj, getBollingerBands (extended from auto-trade)
│   │   └── indicator.interfaces.ts
│   │
│   ├── rules/
│   │   ├── rule-engine.service.ts  // evalTrendEma, evalMeanRevertRsi, evalBbCorrelation
│   │   │                          // evalStochBbPattern, evalStochEmaKdj
│   │   │                          // evalRsiCross, evalRsiZone
│   │   └── rule-engine.interfaces.ts // SignalResult, BtcBbState
│   │
│   └── ai-optimizer/
│       ├── ai-optimizer.service.ts
│       │   - preComputeRegimeIndicators(symbol): RegimeIndicators (no AI, pure math)
│       │   - tuneParamsForSymbol(symbol): AiTunedParams (Haiku call)
│       │   - assessGlobalRegime(): calls Sonnet
│       │   - enforceRateLimit(): uses cache:ai:call_count:{hour}
│       └── ai-optimizer.interfaces.ts  // AiTunedParams, RegimeIndicators, MarketRegime
│
└── ai-signal/
    ├── ai-signal.module.ts
    └── ai-signal.service.ts
        - @Cron('*/30 * * * * *') runSignalScan()
          1. Get shortlist from cache
          2. For each coin, get AiTunedParams (or trigger Haiku if expired)
          3. Route to rule engine based on params.strategy
          4. Dedup: skip if same coin + direction signaled within 1h
          5. If signal → buildIncomingSignal() → handleIncomingSignal()

        - @Cron('0 */5 * * * *') refreshFilter()
          → triggerCoinFilterScan()

        - handleEmergencyOverride(symbol, priceChangePct)
          → if priceChangePct > 5% in 15min → bypass cache TTL, re-analyze
```

---

## Implementation Phases

### Phase 0 — Groundwork (Day 1-2)
**Goal**: Get candle data flowing and cached reliably before any strategy logic.

- `MarketDataService`:
  - `GET /fapi/v1/ticker/24hr` every 5min → `cache:market:scan`
  - Binance WebSocket klines for top 10 coins → stores all 4 OHLC arrays in Redis
  - Handle subscribe/unsubscribe when shortlist changes
- `CoinFilterService`: filter logic, writes `cache:filter:shortlist`
- **Validation**: Check Redis manually — verify OHLC arrays are correct and updating

### Phase 1 — RSI_CROSS + RSI_ZONE (Day 3-4, Week 1)
**Goal**: Working signal system using proven F8 logic. Fastest path to production signals.

- Port `checkConfig2()` → `evalRsiCross()` exactly
- Port `checkConfig3()` → `evalRsiZone()` exactly
- Run with **hardcoded params** matching current F8 config (no AI yet)
- Compare output with what bot-signal/F8 produces — they must match
- Wire to `handleIncomingSignal()` with a new `BOT_TYPE: BOT_FUTURE_AI_1`
- **Go-live gate**: 48h of signals matches expected F8 output

### Phase 2 — TREND_EMA + MEAN_REVERT_RSI (Week 1-2)
**Goal**: Add F1 and F2 logic.

- Port F1 EMA cross logic → `evalTrendEma()`
- Port F2 EMA200+RSI logic → `evalMeanRevertRsi()`
- All still hardcoded params, routing manually by coin (e.g., BTCUSDT uses TREND_EMA on trending days)
- **Validation**: Manually verify each strategy fires correctly on historical candles

### Phase 3 — OHLC Extension + STOCH_BB_PATTERN (Week 2)
**Goal**: Enable F4 strategy (needs high/low data).

- Extend `MarketDataService` to store `candle-high-price` and `candle-low-price` in Redis
- Add `getCandleOhlc()`, `getStochastic()`, `getBollingerBands()` to `IndicatorService`
- Copy `calculateStochastic()`, `calculateKDJ()`, `calculateStochRSI()` from `bot-signal/formula/helper.ts`
- Port F4 2-stage logic → `evalStochBbPattern()` with Redis state management
- **Note**: 2-stage state = `cache:ai-signal:state:{symbol}:STOCH_BB` with 48h TTL

### Phase 4 — STOCH_EMA_KDJ (Week 2-3)
**Goal**: F5 strategy with KDJ.

- Port F5 EMA body-cross logic → `evalStochEmaKdj()`
- Port `calculateKDJ()` from helper.ts
- **Note**: F5 re-queues itself on same candle when stage 1 triggers — replicate this pattern

### Phase 5 — AI Optimizer Goes Live (Week 3)
**Goal**: Replace hardcoded params with AI-tuned params.

- `AiOptimizerService.preComputeRegimeIndicators()`:
  - Compute EMA alignment, BB width, RSI, volume ratio, ATR — pure math, no API calls
  - Returns `RegimeIndicators` struct in ~5ms
- `AiOptimizerService.tuneParamsForSymbol()`:
  - Build prompt with pre-computed indicators (NOT raw candles)
  - Call Haiku API
  - Parse and validate response JSON
  - Store in `cache:ai:params:{symbol}` with TTL
- `AiOptimizerService.assessGlobalRegime()`:
  - Sonnet call every 4h with BTC + top 10 summary
  - Stores in `cache:ai:regime`
- Rate limiter: hard cap 30 Haiku + 2 Sonnet per hour via `cache:ai:call_count:{hour}`
- **Fallback**: If AI call fails or returns invalid JSON → use Phase 1-4 hardcoded defaults

### Phase 6 — BB_CORRELATION (Week 3-4, optional)
**Goal**: F3 correlation strategy.

- Monitor BTC separately in `MarketDataService` (always subscribed, not just when BTC is in shortlist)
- Store BTC BB state in `cache:ai-signal:btcBbState` (updated on every BTC kline)
- When ALT in shortlist + BTC BB state active → `evalBbCorrelation()`

### Phase 7 — Monitoring + Telegram Controls (Week 4)
- Telegram command: `/ai status` — show regime, shortlist, params per coin
- Telegram command: `/ai override BTCUSDT RSI_CROSS` — force a strategy for debugging
- Signal result logging per coin: which strategy, what params, LONG/SHORT, timestamp
- Performance tracking: win rate per strategy per regime (requires position outcome tracking)

---

## Emergency Override System

```typescript
// Triggered when price change > 5% in 15 minutes
async handleEmergencyOverride(symbol: string, priceChangePct: number) {
  this.logger.warn(`Emergency override: ${symbol} moved ${priceChangePct}% in 15min`);

  // 1. Immediately invalidate AI params cache
  await this.redis.del(`cache:ai:params:${symbol}`);

  // 2. Invalidate 2-stage state (stale pattern no longer valid)
  await this.redis.del(`cache:ai-signal:state:${symbol}:STOCH_BB`);
  await this.redis.del(`cache:ai-signal:state:${symbol}:STOCH_EMA`);

  // 3. Force re-analyze (bypass rate limit — emergency is free)
  const freshParams = await this.aiOptimizer.tuneParamsForSymbol(symbol, { emergency: true });

  // 4. Immediately run signal check with fresh params
  await this.runSignalForCoin(symbol, freshParams);
}
```

---

## Signal Deduplication Logic

```typescript
// AiSignalService — before calling handleIncomingSignal
async isDuplicate(symbol: string, isLong: boolean): Promise<boolean> {
  const key = `cache:ai-signal:lastSignal:${symbol}`;
  const last = await this.redis.get(key);
  if (!last) return false;

  const { direction, timestamp } = last;
  const sameDirection = (direction === 'LONG') === isLong;
  const withinWindow = Date.now() - timestamp < 60 * 60 * 1000; // 1h window

  return sameDirection && withinWindow;
}

async recordSignal(symbol: string, isLong: boolean) {
  await this.redis.set(
    `cache:ai-signal:lastSignal:${symbol}`,
    { direction: isLong ? 'LONG' : 'SHORT', timestamp: Date.now() },
    3600, // 1h TTL
  );
}
```

---

## Strategy Selection Decision Tree (for AI Prompt Guidance)

```
Is bbWidth > 4%?
  YES → Is volumeRatio > 2x?
    YES → VOLATILE → RSI_ZONE (extreme OB/OS reversals, tight SL)
    NO  → VOLATILE → STOCH_EMA_KDJ (momentum, EMA body cross entry)

  NO → Is emaTrend BULLISH or BEARISH?
    YES → Is priceChange24h direction same as emaTrend?
      YES → STRONG_TREND → TREND_EMA (fast/slow EMA cross)
      NO  → STRONG_TREND → RSI_CROSS (pullback momentum entry)

    NO (MIXED) → Is bbWidth < 2%?
      YES → RANGE_BOUND → STOCH_BB_PATTERN (highest precision for ranging)
      NO  → RANGE_BOUND → MEAN_REVERT_RSI (near EMA200 with RSI extreme)

  Special: Is BTC in BB extreme AND ALT correlates?
    → BTC_CORRELATION → BB_CORRELATION
```

---

## Risk Management Layer

```typescript
// AiSignalService — before executing signal
interface RiskCheck {
  maxConcurrentSignalsPerStrategy: number;  // e.g., 3 — don't spam same strategy
  maxConcurrentSignals: number;             // e.g., 5 — total across all coins
  minTimeBetweenSignalsSameCoin: number;    // 60 min
  skipIfLowConfidence: boolean;             // skip if AI confidence < minConfidenceToTrade
}

// If AI confidence < 60 → don't trade (too uncertain)
// If same strategy already has 3 open positions → skip
// If same coin already has a signal in last 1h → skip
```

---

## Quick Start Priority (What to Build First)

```
Week 1, Day 1-2:  MarketDataService + CoinFilterService (data foundation)
Week 1, Day 3-5:  IndicatorService (RSI methods) + evalRsiCross + evalRsiZone
Week 1, Day 5:    Wire to handleIncomingSignal() — SYSTEM IS LIVE (same as F8 logic)

Week 2:           evalTrendEma + evalMeanRevertRsi + OHLC extension
Week 3:           evalStochBbPattern (F4) + AiOptimizerService (Haiku)
Week 4:           evalStochEmaKdj (F5) + Sonnet global regime + monitoring
```

**The critical milestone is end of Week 1**: a working system that runs the same RSI logic as F8, but **per-coin** and **integrated inside binance-tele-bot** instead of routing via TCP from bot-signal.

By Week 3, the AI is actively selecting different strategies for different coins based on their individual market regimes — which is the core innovation.
