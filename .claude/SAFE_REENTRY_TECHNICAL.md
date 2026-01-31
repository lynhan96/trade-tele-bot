# Safe Re-entry System - Technical Documentation

## Overview

The Safe Re-entry System implements technical analysis conditions to prevent re-entering positions during market crashes or unfavorable conditions. Instead of blindly re-entering at the original entry price, the system analyzes market conditions and only executes re-entry when technical indicators align.

## Problem Solved

**Before:**

```
Position closes at TP $110 with $10 profit
Price returns to $100 → Re-enter automatically
But market is crashing → Hit SL at $90 → Lose $8.50
```

**After:**

```
Position closes at TP $110 with $10 profit
Price drops to $80 (market correction)
System checks:
✅ Cooldown passed (30 min)
✅ Price in range (20% drop, within 5-25%)
✅ EMA9 > EMA21 (uptrend starting)
✅ Buy pressure > 55% (accumulation)
→ Re-enter at $80 (better entry!)
```

---

## Safety Checks

### 1. Cooldown Period (30 Minutes)

**Purpose:** Prevent immediate re-entry during initial crash/dump

**Logic:**

```typescript
const timeSinceClose = Date.now() - closedAt;
const cooldownMinutes = 30;

if (timeSinceClose < cooldownMinutes * 60 * 1000) {
  return { safe: false, reason: "Cooldown active" };
}
```

**Example:**

```
10:00 AM - Close position at $110
10:05 AM - Price at $100 → Skip (5 min < 30 min)
10:15 AM - Price at $95 → Skip (15 min < 30 min)
10:35 AM - Price at $90 → Check other conditions ✅
```

---

### 2. Price Range Check (5-25% Move)

**Purpose:** Look for better entries than original price, avoid small fluctuations

**Logic:**

```typescript
// For LONG: Price should be 5-25% BELOW original entry
// For SHORT: Price should be 5-25% ABOVE original entry

const priceChange = isLong
  ? ((entryPrice - currentPrice) / entryPrice) * 100
  : ((currentPrice - entryPrice) / entryPrice) * 100;

if (priceChange < 5 || priceChange > 25) {
  return { safe: false, reason: "Price not in range" };
}
```

**Examples:**

| Original Entry | Current | Change | LONG Re-entry? | Reason            |
| -------------- | ------- | ------ | -------------- | ----------------- |
| $100           | $99     | 1%     | ❌             | Too small (< 5%)  |
| $100           | $90     | 10%    | ✅             | In range          |
| $100           | $80     | 20%    | ✅             | In range          |
| $100           | $70     | 30%    | ❌             | Too large (> 25%) |

**Rationale:**

- **< 5%**: Too close to original, no advantage
- **5-25%**: Good correction/dip for better entry
- **> 25%**: Market structure broken, too risky

---

### 3. EMA Crossover (Trend Direction)

**Purpose:** Ensure trend is in our favor before re-entry

**What is EMA?**

- Exponential Moving Average
- Gives more weight to recent prices
- EMA9 = fast (reacts quickly to price changes)
- EMA21 = slow (shows overall trend)

**Formula:**

```typescript
multiplier = 2 / (period + 1)
EMA = (currentPrice - previousEMA) × multiplier + previousEMA
```

**Signal:**

```typescript
const ema9 = calculateEMA(closePrices, 9);
const ema21 = calculateEMA(closePrices, 21);

// For LONG
if (ema9 > ema21) {
  // Fast EMA above slow = Uptrend starting ✅
}

// For SHORT
if (ema9 < ema21) {
  // Fast EMA below slow = Downtrend starting ✅
}
```

**Visual Example:**

```
LONG Position - Bullish Crossover

Price Chart (15-min candles):
$95  ─────────────────────
$90         EMA9 ────────── (faster, crosses above)
$85    EMA21 ──────────── (slower)
$80
$75
     └──────────────────────→ Time

EMA9 crosses ABOVE EMA21 = Uptrend starting
→ Safe to re-enter LONG ✅


SHORT Position - Bearish Crossover

Price Chart:
$110
$105    EMA21 ──────────── (slower)
$100        EMA9 ────────── (faster, crosses below)
$95  ─────────────────────
     └──────────────────────→ Time

EMA9 crosses BELOW EMA21 = Downtrend starting
→ Safe to re-enter SHORT ✅
```

---

### 4. Volume Pressure (Buy/Sell Ratio)

**Purpose:** Confirm buying interest (for LONG) or selling pressure (for SHORT)

**Calculation:**

```typescript
// Analyze last 20 candles (5 hours of 15-min candles)
for (const candle of last20Candles) {
  if (candle.close > candle.open) {
    // Green candle = Buy pressure
    totalBuyVolume += candle.volume;
  } else {
    // Red candle = Sell pressure
    totalSellVolume += candle.volume;
  }
}

buyPressure = totalBuyVolume / (totalBuyVolume + totalSellVolume);

// For LONG: Need >55% buy pressure
// For SHORT: Need <45% buy pressure (>55% sell)
```

**Example:**

```
Last 20 candles for BTC:
12 green candles: 550 BTC volume
8 red candles: 450 BTC volume

Buy Pressure = 550 / (550 + 450) = 55%

For LONG: 55% > 55% ✅ (just met threshold)
For SHORT: 55% < 45% ❌ (not enough sell pressure)
```

**Why 55%?**

- 50% = Neutral (equal buy/sell)
- > 55% = Clear buying dominance
- <45% = Clear selling dominance

---

## Complete Flow Example

### Scenario: BTC LONG Position

**Initial Trade:**

```
Entry: $100
Quantity: 1 BTC
TP: 10% = $110
Profit: $10 ✅ (closed)
```

**Market Correction:**

```
10:00 AM - Close at $110 (+$10)
10:05 AM - Price $105 (5% drop)
10:15 AM - Price $95 (14% drop)
10:30 AM - Price $85 (23% drop)
11:00 AM - Price $80 (27% drop)
11:30 AM - Price $82 (25% drop)
```

**Re-entry Analysis at 11:30 AM ($82):**

```typescript
// 1. Cooldown ✅
timeSinceClose = 90 minutes (> 30 min) ✅

// 2. Price Range ✅
priceChange = (100 - 82) / 100 = 18% (within 5-25%) ✅

// 3. EMA Crossover ✅
ema9 = $83.50
ema21 = $81.20
ema9 > ema21 = TRUE ✅ (uptrend starting)

// 4. Volume Pressure ✅
Last 20 candles:
- Buy volume: 580 BTC
- Sell volume: 420 BTC
- Buy pressure: 58% (> 55%) ✅

ALL CHECKS PASSED → RE-ENTER! 🎯
```

**Re-entry Execution:**

```
Entry: $82 (better than $100!)
Quantity: 0.85 BTC (15% reduction)
TP: $90.20 (10%)
SL: $72 (profit protected)

Potential outcomes:
- TP hit: +$6.97 → Total: $10 + $6.97 = $16.97 🎯
- SL hit: -$8.50 → Total: $10 - $8.50 = $1.50 ✅

Either way, we profit!
```

---

## Technical Implementation

### Data Sources

**Binance:**

```typescript
const klines = await binanceService.futuresCandles({
  symbol: "BTCUSDT",
  interval: "15m",
  limit: 30,
});

// Returns: [openTime, open, high, low, close, volume, ...]
```

**OKX:**

```typescript
const response = await okxService.get("/api/v5/market/candles", {
  params: {
    instId: "BTC-USDT-SWAP",
    bar: "15m",
    limit: "30",
  },
});

// Returns: [[timestamp, open, high, low, close, volume], ...]
```

### EMA Calculation

```typescript
function calculateEMA(prices: number[], period: number): number {
  // 1. Calculate SMA for first period
  let ema = prices.slice(0, period).reduce((a, b) => a + b) / period;

  // 2. Calculate multiplier
  const multiplier = 2 / (period + 1);

  // 3. Calculate EMA for remaining prices
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }

  return ema;
}

// Example:
prices = [100, 102, 101, 103, 105, 104, 106, 108, 107];
ema9 = calculateEMA(prices, 9); // Returns latest EMA9 value
```

---

## Monitoring & Debugging

### Log Messages

**Safety Check Failed:**

```
Re-entry blocked for BTCUSDT: Cooldown active (15/30 min)
Re-entry blocked for ETHUSDT: Price -2.3% from entry (need 5-25%)
Re-entry blocked for SOLUSDT: EMA not aligned (EMA9: 78.5, EMA21: 82.3)
Re-entry blocked for AVAXUSDT: Volume pressure not favorable (48.2% buy)
```

**Safety Check Passed:**

```
✅ Re-entry safety checks passed for BTCUSDT:
   Price change: 18.50%,
   EMA9: 83.50, EMA21: 81.20,
   Buy pressure: 58.5%
```

### Redis Data

```json
{
  "symbol": "BTCUSDT",
  "entryPrice": 100,
  "closedAt": "2026-01-31T10:00:00Z",
  "side": "LONG",
  "quantity": 0.85,
  "stopLossPrice": 72
}
```

---

## Benefits

1. **Risk Management** - Avoids re-entering during crashes
2. **Better Entries** - Waits for 5-25% correction for improved entry price
3. **Trend Alignment** - Only enters when trend is favorable (EMA)
4. **Volume Confirmation** - Ensures buying/selling interest exists
5. **Cooldown Protection** - Prevents emotional/immediate re-entries
6. **Increased Profits** - Better entries = more profit potential

---

## Future Enhancements

### Possible Additions:

1. **RSI Filter**

```typescript
if (rsi < 30) {
  // Oversold for LONG
  // Overbought for SHORT
}
```

2. **Support/Resistance Levels**

```typescript
if (nearSupport) {
  // Price at historical support
}
```

3. **User Configuration**

```
/setretry 5 15 30 60
         │  │  │  └─ Cooldown minutes
         │  │  └──── Max price change %
         │  └─────── Volume reduction %
         └────────── Max retries
```

4. **Multiple Timeframe Analysis**

```typescript
// Check 15m AND 1h EMAs
const ema15m = await getEMA(symbol, "15m", 9);
const ema1h = await getEMA(symbol, "1h", 9);
```

---

## Configuration

Current settings (hardcoded):

- **Cooldown:** 30 minutes
- **Price Range:** 5-25% from original entry
- **EMA Periods:** 9 and 21
- **Volume Threshold:** 55% buy pressure
- **Candle Timeframe:** 15 minutes
- **Analysis Period:** 30 candles (7.5 hours)

All configurable in `checkReentrySafety()` method.
