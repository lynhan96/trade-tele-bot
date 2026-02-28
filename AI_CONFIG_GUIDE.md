# AI Configuration Guide - Optimal Settings

## Quick Start Recommendations

### 🎯 Conservative Trader (Low Risk, High Quality Signals)

```env
AI_MIN_COIN_VOLUME_USD=100000000    # Only major coins (BTC, ETH, BNB, SOL)
AI_MIN_PRICE_CHANGE_PCT=2.0         # Strong momentum required
AI_MAX_SHORTLIST_SIZE=5             # Focus on best opportunities
AI_MAX_HAIKU_PER_HOUR=20            # Lower costs (~$2/month)
AI_MAX_SONNET_PER_HOUR=1            # Minimal advanced analysis
AI_TEST_MODE=false
```

**Expected Results:**

- 3-8 high-quality signals per day
- Lower API costs ($2-3/month)
- Most stable/liquid markets only
- Best for: Beginners, risk-averse traders

---

### ⚡ Balanced Trader (Recommended for Most Users)

```env
AI_MIN_COIN_VOLUME_USD=50000000     # Top 20-30 coins
AI_MIN_PRICE_CHANGE_PCT=1.0         # Moderate momentum filter
AI_MAX_SHORTLIST_SIZE=10            # Good variety
AI_MAX_HAIKU_PER_HOUR=30            # Standard rate (~$4/month)
AI_MAX_SONNET_PER_HOUR=2            # Regular regime checks
AI_TEST_MODE=false
```

**Expected Results:**

- 8-15 signals per day
- Balanced API costs ($4-6/month)
- Mix of major and mid-cap coins
- Best for: Intermediate traders with moderate risk tolerance

---

### 🚀 Aggressive Trader (High Frequency, More Opportunities)

```env
AI_MIN_COIN_VOLUME_USD=30000000     # Top 50+ coins
AI_MIN_PRICE_CHANGE_PCT=0.5         # Catch early moves
AI_MAX_SHORTLIST_SIZE=15            # Maximum coverage
AI_MAX_HAIKU_PER_HOUR=40            # Higher refresh rate (~$6/month)
AI_MAX_SONNET_PER_HOUR=3            # Frequent regime updates
AI_TEST_MODE=false
```

**Expected Results:**

- 15-30 signals per day
- Higher API costs ($6-10/month)
- Includes volatile mid/small-cap coins
- Best for: Active traders, higher risk tolerance

---

## Configuration Parameter Deep Dive

### 📊 AI_MIN_COIN_VOLUME_USD

**What it does:** Filters coins by 24-hour trading volume  
**Impact:** Liquidity, slippage, market stability

| Value | Typical Coins     | Use Case                     |
| ----- | ----------------- | ---------------------------- |
| 150M+ | BTC, ETH, BNB     | Ultra-safe, major pairs only |
| 100M+ | +SOL, XRP, ADA    | Conservative approach        |
| 50M+  | +DOGE, MATIC, DOT | **Recommended default**      |
| 30M+  | +AVAX, LINK, UNI  | Active trading               |
| 10M+  | +Many altcoins    | High risk, potential rewards |

**Pro Tips:**

- During bear markets: Increase to 100M+ (focus on survivors)
- During bull markets: Can lower to 30M+ (more opportunities)
- Check actual volume on Binance before lowering below 30M

---

### 📈 AI_MIN_PRICE_CHANGE_PCT

**What it does:** Filters coins by absolute 24h price movement  
**Impact:** Signal frequency, momentum quality

| Value | Signal Frequency      | Market Condition            |
| ----- | --------------------- | --------------------------- |
| 3.0%  | Very low (2-5/day)    | Extreme risk-off            |
| 2.0%  | Low (5-10/day)        | Conservative                |
| 1.5%  | Medium (8-15/day)     | Normal market               |
| 1.0%  | High (10-20/day)      | **Recommended default**     |
| 0.5%  | Very high (15-30/day) | Bull market/high volatility |
| 0.3%  | Extreme (20-40/day)   | Catch everything (noisy)    |

**Pro Tips:**

- Pair with volume filter: High volume + low price change = ranging market
- Trending markets: 0.5-1.0% works well
- Choppy/sideways: Increase to 1.5-2.0% to reduce noise
- After major news: Temporarily increase to catch only strong moves

---

### 🎲 AI_MAX_SHORTLIST_SIZE

**What it does:** Maximum coins monitored simultaneously  
**Impact:** Diversification, API costs, signal quality

| Size  | Monitoring Approach | Cost        | Best For                |
| ----- | ------------------- | ----------- | ----------------------- |
| 3-5   | Laser-focused       | Low         | Single-strategy traders |
| 6-8   | Selective           | Medium-low  | Quality over quantity   |
| 10-12 | Balanced            | Medium      | **Recommended**         |
| 13-15 | Comprehensive       | Medium-high | Active portfolio        |
| 16-20 | Maximum coverage    | High        | Advanced users only     |

**Pro Tips:**

- More coins ≠ more profit (quality > quantity)
- Each coin requires: WebSocket stream + indicator calculations + AI analysis
- Sweet spot: 8-12 coins for most trading styles
- Monitor your signal execution rate: If < 30% signals executed → reduce size

---

### 🤖 AI_MAX_HAIKU_PER_HOUR

**What it does:** Rate limit for Claude Haiku API calls (parameter tuning)  
**Cost:** ~$0.25 input + $1.25 output per 1M tokens

| Rate | Daily Calls | Monthly Cost | Use Case                  |
| ---- | ----------- | ------------ | ------------------------- |
| 10   | ~240        | $1-2         | Minimal (mostly defaults) |
| 20   | ~480        | $2-3         | Conservative              |
| 30   | ~720        | $4-5         | **Recommended**           |
| 40   | ~960        | $6-8         | Active trading            |
| 50   | ~1,200      | $8-12        | Maximum adaptation        |

**How it's used:**

- Initial coin analysis (regime detection)
- Parameter tuning per strategy
- Refreshed when: Cache expires (1h), price moves >5%, manual override
- Average: 1-3 calls per coin per hour under normal conditions

**Optimization Tips:**

- **20/hour** sufficient if monitoring 5-8 stable coins
- **30/hour** good balance for 10-12 coins
- **40+/hour** only needed for 15+ coins or highly volatile markets
- Check actual usage: Most days use 60-80% of limit

---

### 🧠 AI_MAX_SONNET_PER_HOUR

**What it does:** Rate limit for Claude Sonnet API calls (regime analysis)  
**Cost:** ~$3 input + $15 output per 1M tokens (12x more expensive)

| Rate | Daily Calls | Monthly Cost | Use Case               |
| ---- | ----------- | ------------ | ---------------------- |
| 0.5  | ~12         | $1           | Rare regime checks     |
| 1    | ~24         | $2           | Minimal                |
| 2    | ~48         | $3-4         | **Recommended**        |
| 3    | ~72         | $5-6         | Active regime tracking |
| 5    | ~120        | $8-12        | Maximum insights       |

**How it's used:**

- Global market regime analysis (STRONG_TREND, RANGE_BOUND, VOLATILE, BTC_CORRELATION)
- Deep multi-coin correlation analysis
- Emergency market condition assessment (>5% moves)
- Less frequent than Haiku (higher-level decisions)

**Optimization Tips:**

- **1/hour** = Once per hour regime check (sufficient for swing trading)
- **2/hour** = Every 30 min (good for intraday)
- **3+/hour** = Only if trading 15+ coins in volatile conditions
- Sonnet calls are cached for 2 hours (longer than Haiku's 1 hour)

---

## Strategy-Specific Recommendations

### 📉 Intraday Trading (15m timeframe)

```env
AI_MIN_COIN_VOLUME_USD=50000000
AI_MIN_PRICE_CHANGE_PCT=1.0
AI_MAX_SHORTLIST_SIZE=12
AI_MAX_HAIKU_PER_HOUR=35      # More frequent updates
AI_MAX_SONNET_PER_HOUR=2
```

**Why:**

- 15m signals need fresher data → higher Haiku rate
- Medium shortlist to catch intraday moves
- Volume filter prevents low-liquidity spikes

---

### 📊 Swing Trading (4h timeframe)

```env
AI_MIN_COIN_VOLUME_USD=70000000
AI_MIN_PRICE_CHANGE_PCT=1.5
AI_MAX_SHORTLIST_SIZE=8
AI_MAX_HAIKU_PER_HOUR=25      # Lower frequency OK
AI_MAX_SONNET_PER_HOUR=1      # Regime changes slower
```

**Why:**

- 4h timeframe = slower decisions → less frequent API calls
- Higher volume filter for stable swing positions
- Fewer coins but higher conviction

---

### 🌙 Overnight/Weekend Bot

```env
AI_MIN_COIN_VOLUME_USD=100000000  # Only ultra-liquid pairs
AI_MIN_PRICE_CHANGE_PCT=2.0        # Strong signals only
AI_MAX_SHORTLIST_SIZE=5
AI_MAX_HAIKU_PER_HOUR=20
AI_MAX_SONNET_PER_HOUR=1
AI_TEST_MODE=false
```

**Why:**

- Unmonitored trading requires highest quality signals
- Major pairs have 24/7 liquidity
- Lower signal count = fewer positions to manage

---

## Cost Optimization Strategies

### 💰 Budget Mode ($2-3/month)

- Use **AI_MIN_COIN_VOLUME_USD=80000000** (top 10 coins only)
- Set **AI_MAX_HAIKU_PER_HOUR=20**
- Set **AI_MAX_SONNET_PER_HOUR=1**
- Set **AI_MAX_SHORTLIST_SIZE=6**
- Strategy: Quality signals on major pairs

### 💵 Standard Mode ($4-6/month)

- Default configuration (see Balanced Trader above)
- Good performance/cost ratio
- Suitable for most users

### 💎 Performance Mode ($8-12/month)

- Use **AI_MAX_HAIKU_PER_HOUR=40-50**
- Set **AI_MAX_SONNET_PER_HOUR=3-5**
- Monitor 15+ coins
- Strategy: Maximum signal coverage and adaptation

---

## Testing & Validation

### Phase 1: Safe Testing (Week 1)

```env
AI_TEST_MODE=true              # No real trades
AI_MIN_COIN_VOLUME_USD=50000000
AI_MAX_SHORTLIST_SIZE=8
AI_MAX_HAIKU_PER_HOUR=25
```

**Goal:** Validate signal quality, check API costs, tune parameters

### Phase 2: Paper Trading (Week 2)

```env
AI_TEST_MODE=true
# Use your preferred settings from Phase 1
```

**Goal:** Track hypothetical performance, refine coin filters

### Phase 3: Live Small Volume (Week 3-4)

```env
AI_TEST_MODE=false
# Start with small position sizes
# Monitor win rate and P&L
```

**Goal:** Real execution, build confidence

### Phase 4: Production

```env
AI_TEST_MODE=false
# Scale up position sizes based on results
```

---

## Market Condition Adjustments

### 🐂 Bull Market

- Lower `AI_MIN_PRICE_CHANGE_PCT` to 0.5-0.8 (more opportunities)
- Lower `AI_MIN_COIN_VOLUME_USD` to 30M (catch altcoin moves)
- Increase `AI_MAX_SHORTLIST_SIZE` to 15

### 🐻 Bear Market

- Raise `AI_MIN_COIN_VOLUME_USD` to 100M+ (safety first)
- Raise `AI_MIN_PRICE_CHANGE_PCT` to 2.0+ (only strong moves)
- Reduce `AI_MAX_SHORTLIST_SIZE` to 5-8

### 📈 High Volatility

- Increase `AI_MAX_HAIKU_PER_HOUR` to 40+ (adapt faster)
- Increase `AI_MAX_SONNET_PER_HOUR` to 3+ (regime changes)
- Moderate volume/price filters

### 😴 Low Volatility / Sideways

- Increase `AI_MIN_PRICE_CHANGE_PCT` to 1.5-2.0 (avoid chop)
- Reduce API rates to save costs
- Focus on fewer, higher-quality setups

---

## Monitoring & Optimization

### Key Metrics to Track

1. **Signal Execution Rate**
   - Target: 30-50% of signals result in trades
   - Too low → your filters might be too strict
   - Too high → possibly taking lower-quality signals

2. **API Cost Per Signal**
   - Target: $0.15-0.30 per executed trade
   - Check: Total monthly cost / total signals executed
   - Optimize: Reduce rates if cost per signal > $0.50

3. **Win Rate by Strategy**
   - Use `/ai stats` command
   - Focus on strategies with 60%+ win rate
   - Consider overriding to preferred strategy

4. **Signal Staleness** (QUEUED → CANCELLED)
   - Target: < 20% of queued signals expire
   - Too high → positions held too long or signal TTL too short

### Optimization Loop (Monthly)

1. Review `/ai stats` performance
2. Check actual API usage vs limits
3. Adjust coin filters based on execution rate
4. Test parameter changes in TEST_MODE first
5. Compare results before/after changes

---

## Common Configurations Q&A

**Q: I'm getting too many signals (20+/day). What should I change?**  
A: Increase `AI_MIN_COIN_VOLUME_USD` to 80M and `AI_MIN_PRICE_CHANGE_PCT` to 1.5

**Q: Not enough signals (< 5/day). What's wrong?**  
A: Lower `AI_MIN_PRICE_CHANGE_PCT` to 0.5-0.8 and increase `AI_MAX_SHORTLIST_SIZE` to 15

**Q: API costs too high (> $10/month). How to reduce?**  
A: Lower `AI_MAX_HAIKU_PER_HOUR` to 20 and `AI_MAX_SONNET_PER_HOUR` to 1. Reduce `AI_MAX_SHORTLIST_SIZE` to 8.

**Q: Signal quality is poor (low win rate). Help?**  
A: Increase `AI_MIN_COIN_VOLUME_USD` to 100M, `AI_MIN_PRICE_CHANGE_PCT` to 2.0, and reduce `AI_MAX_SHORTLIST_SIZE` to 5.

**Q: Should I ever set AI_ENABLED=false?**  
A: Only if you want manual-only trading or the bot to only execute signals from external TCP service.

**Q: When to use AI_TEST_MODE=true?**  
A: Always start with TEST_MODE for 1-2 weeks to validate behavior without risking capital.

---

## Advanced: Dynamic Configuration

For advanced users, consider adjusting parameters based on:

- Time of day (higher rates during active trading hours)
- Day of week (reduce on weekends if volume drops)
- Recent win rate (tighten filters after losing streaks)
- Overall market volatility (VIX-like indicator)

Example automation (pseudo-code):

```python
if daily_volatility > 5%:
    AI_MAX_HAIKU_PER_HOUR = 40
    AI_MIN_PRICE_CHANGE_PCT = 0.5
elif daily_volatility < 1%:
    AI_MAX_HAIKU_PER_HOUR = 20
    AI_MIN_PRICE_CHANGE_PCT = 2.0
```

---

## Summary: Best Starting Point

**For 90% of users, start here:**

```env
AI_ENABLED=true
AI_TEST_MODE=true                    # Start safe!
AI_MIN_COIN_VOLUME_USD=50000000
AI_MIN_PRICE_CHANGE_PCT=1.0
AI_MAX_SHORTLIST_SIZE=10
AI_MAX_HAIKU_PER_HOUR=30
AI_MAX_SONNET_PER_HOUR=2
```

After 1-2 weeks of testing, adjust based on:

- Your risk tolerance
- Desired signal frequency
- Budget for API costs
- Trading timeframe preference (intraday vs swing)

**Remember:** Start conservative, test thoroughly, and adjust gradually based on results!
