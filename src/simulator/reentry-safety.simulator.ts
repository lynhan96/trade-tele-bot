/**
 * Re-entry Safety Simulator
 * Tests all safety check scenarios with predefined market data
 */

interface Candle {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface ReentryData {
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  closedAt: string;
}

interface SafetyCheckResult {
  safe: boolean;
  reason?: string;
  details?: {
    cooldown?: string;
    priceChange?: string;
    ema9?: number;
    ema21?: number;
    buyPressure?: number;
  };
}

export class ReentrySafetySimulator {
  /**
   * Calculate EMA (same logic as telegram.service.ts)
   */
  private calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1];

    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b) / period;

    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * Check re-entry safety (same logic as telegram.service.ts)
   */
  private checkReentrySafety(
    currentPrice: number,
    reentryData: ReentryData,
    klines: Candle[],
  ): SafetyCheckResult {
    const isLong = reentryData.side === "LONG";
    const details: any = {};

    // 1. Cooldown Check (30 minutes minimum)
    const timeSinceClose =
      Date.now() - new Date(reentryData.closedAt).getTime();
    const cooldownMinutes = 30;
    details.cooldown = `${Math.floor(timeSinceClose / 60000)}/${cooldownMinutes} min`;

    if (timeSinceClose < cooldownMinutes * 60 * 1000) {
      return {
        safe: false,
        reason: `Cooldown active (${details.cooldown})`,
        details,
      };
    }

    // 2. Price Range Check (5-25% from original entry)
    const priceChange = isLong
      ? ((reentryData.entryPrice - currentPrice) / reentryData.entryPrice) * 100
      : ((currentPrice - reentryData.entryPrice) / reentryData.entryPrice) *
        100;

    details.priceChange = `${priceChange.toFixed(2)}%`;

    if (priceChange < 5 || priceChange > 25) {
      return {
        safe: false,
        reason: `Price ${priceChange.toFixed(2)}% from entry (need 5-25%)`,
        details,
      };
    }

    // 3. EMA Crossover Check
    const closes = klines.map((k) => parseFloat(k.close));
    const ema9 = this.calculateEMA(closes, 9);
    const ema21 = this.calculateEMA(closes, 21);

    details.ema9 = ema9;
    details.ema21 = ema21;

    const emaConditionMet = isLong ? ema9 > ema21 : ema9 < ema21;
    if (!emaConditionMet) {
      return {
        safe: false,
        reason: `EMA not aligned (EMA9: ${ema9.toFixed(2)}, EMA21: ${ema21.toFixed(2)})`,
        details,
      };
    }

    // 4. Volume Pressure Check (>55% buy for LONG, >55% sell for SHORT)
    const last20Candles = klines.slice(-20);
    let totalBuyVolume = 0;
    let totalSellVolume = 0;

    for (const candle of last20Candles) {
      const open = parseFloat(candle.open);
      const close = parseFloat(candle.close);
      const volume = parseFloat(candle.volume);

      if (close > open) {
        totalBuyVolume += volume;
      } else {
        totalSellVolume += volume;
      }
    }

    const buyPressure = totalBuyVolume / (totalBuyVolume + totalSellVolume);
    details.buyPressure = buyPressure;

    const volumeConditionMet = isLong ? buyPressure > 0.55 : buyPressure < 0.45;

    if (!volumeConditionMet) {
      return {
        safe: false,
        reason: `Volume pressure not favorable (${(buyPressure * 100).toFixed(1)}% buy)`,
        details,
      };
    }

    // All checks passed
    return {
      safe: true,
      details,
    };
  }

  /**
   * Generate market data scenarios
   */
  private generateKlines(scenario: string, basePrice: number): Candle[] {
    const now = Date.now();
    const candles: Candle[] = [];

    switch (scenario) {
      case "CRASH_CONTINUING":
        // Market crash - continuous downtrend, EMA9 < EMA21, high sell volume
        for (let i = 30; i > 0; i--) {
          const price = basePrice + i * 50; // Prices going down from high
          const open = price;
          const close = price - 30; // Red candles
          candles.push({
            openTime: now - i * 15 * 60 * 1000,
            open: open.toString(),
            high: (open + 10).toString(),
            low: (close - 5).toString(),
            close: close.toString(),
            volume: "1000000", // High volume
          });
        }
        break;

      case "HEALTHY_PULLBACK":
        // Healthy pullback - recovery starting, EMA9 > EMA21, good buy volume
        // First 15 candles: strong downtrend
        for (let i = 30; i > 15; i--) {
          const price = basePrice + i * 50;
          candles.push({
            openTime: now - i * 15 * 60 * 1000,
            open: price.toString(),
            high: (price + 20).toString(),
            low: (price - 60).toString(),
            close: (price - 50).toString(),
            volume: "900000",
          });
        }
        // Last 15 candles: strong recovery (green candles with momentum)
        for (let i = 15; i > 0; i--) {
          const price = basePrice + i * 10;
          candles.push({
            openTime: now - i * 15 * 60 * 1000,
            open: price.toString(),
            high: (price + 80).toString(),
            low: (price - 10).toString(),
            close: (price + 70).toString(), // Strong green candles
            volume: "1500000", // Very high buy volume
          });
        }
        break;

      case "WEAK_BOUNCE":
        // Weak bounce - small recovery, EMA9 > EMA21 but weak buy volume
        for (let i = 30; i > 15; i--) {
          const price = basePrice + i * 20;
          candles.push({
            openTime: now - i * 15 * 60 * 1000,
            open: price.toString(),
            high: (price + 10).toString(),
            low: (price - 30).toString(),
            close: (price - 20).toString(),
            volume: "600000",
          });
        }
        // Small recovery with low volume
        for (let i = 15; i > 0; i--) {
          const price = basePrice - i * 2;
          const isGreen = i % 3 === 0; // Only 1/3 green candles
          candles.push({
            openTime: now - i * 15 * 60 * 1000,
            open: price.toString(),
            high: (price + 15).toString(),
            low: (price - 10).toString(),
            close: isGreen ? (price + 10).toString() : (price - 5).toString(),
            volume: "400000", // Low volume
          });
        }
        break;

      case "SIDEWAYS":
        // Sideways market - no clear trend, mixed signals
        for (let i = 30; i > 0; i--) {
          const price = basePrice + Math.sin(i) * 20;
          const isGreen = i % 2 === 0;
          candles.push({
            openTime: now - i * 15 * 60 * 1000,
            open: price.toString(),
            high: (price + 15).toString(),
            low: (price - 15).toString(),
            close: isGreen ? (price + 8).toString() : (price - 8).toString(),
            volume: "700000",
          });
        }
        break;

      case "STRONG_RECOVERY":
        // Strong recovery - clear uptrend, EMA9 >> EMA21, strong buy volume
        // First 12 candles: crash down
        for (let i = 30; i > 18; i--) {
          const price = basePrice + i * 60;
          candles.push({
            openTime: now - i * 15 * 60 * 1000,
            open: price.toString(),
            high: (price + 20).toString(),
            low: (price - 80).toString(),
            close: (price - 70).toString(),
            volume: "1000000",
          });
        }
        // Last 18 candles: massive recovery rally
        for (let i = 18; i > 0; i--) {
          const price = basePrice + i * 15;
          candles.push({
            openTime: now - i * 15 * 60 * 1000,
            open: price.toString(),
            high: (price + 100).toString(),
            low: (price - 5).toString(),
            close: (price + 90).toString(), // Huge green candles
            volume: "2000000", // Massive buy volume
          });
        }
        break;

      default:
        throw new Error(`Unknown scenario: ${scenario}`);
    }

    return candles;
  }

  /**
   * Run test scenario
   */
  private runScenario(
    scenarioName: string,
    description: string,
    reentryData: ReentryData,
    currentPrice: number,
    marketScenario: string,
    expectedResult: boolean,
  ) {
    console.log("\n" + "=".repeat(80));
    console.log(`📊 SCENARIO: ${scenarioName}`);
    console.log("=".repeat(80));
    console.log(`Description: ${description}`);
    console.log("\n📍 INPUT DATA:");
    console.log(`  Symbol: ${reentryData.symbol}`);
    console.log(`  Side: ${reentryData.side}`);
    console.log(
      `  Original Entry: $${reentryData.entryPrice.toLocaleString()}`,
    );
    console.log(
      `  Closed At: ${new Date(reentryData.closedAt).toLocaleTimeString()}`,
    );
    console.log(`  Current Price: $${currentPrice.toLocaleString()}`);
    console.log(`  Market Condition: ${marketScenario}`);

    // Generate market data
    const klines = this.generateKlines(marketScenario, currentPrice);

    // Run safety checks
    const result = this.checkReentrySafety(currentPrice, reentryData, klines);

    console.log("\n🔍 SAFETY CHECKS:");
    console.log(`  1. Cooldown: ${result.details?.cooldown || "N/A"}`);
    console.log(`  2. Price Change: ${result.details?.priceChange || "N/A"}`);
    console.log(`  3. EMA9: ${result.details?.ema9?.toFixed(2) || "N/A"}`);
    console.log(`  4. EMA21: ${result.details?.ema21?.toFixed(2) || "N/A"}`);
    console.log(
      `  5. Buy Pressure: ${result.details?.buyPressure ? (result.details.buyPressure * 100).toFixed(1) + "%" : "N/A"}`,
    );

    console.log("\n📤 OUTPUT:");
    console.log(`  Safe to Re-enter: ${result.safe ? "✅ YES" : "❌ NO"}`);
    if (!result.safe && result.reason) {
      console.log(`  Reason: ${result.reason}`);
    }

    console.log("\n🎯 EXPECTED vs ACTUAL:");
    console.log(`  Expected: ${expectedResult ? "✅ ALLOW" : "❌ BLOCK"}`);
    console.log(`  Actual: ${result.safe ? "✅ ALLOW" : "❌ BLOCK"}`);
    const passed = result.safe === expectedResult;
    console.log(`  Test Result: ${passed ? "✅ PASSED" : "❌ FAILED"}`);

    return passed;
  }

  /**
   * Run all test scenarios
   */
  public runAllTests() {
    console.log("\n🚀 STARTING RE-ENTRY SAFETY SIMULATOR");
    console.log("Testing all scenarios with predefined market conditions\n");

    const now = Date.now();
    const results: boolean[] = [];

    // Scenario 1: Market Crash - Should BLOCK
    results.push(
      this.runScenario(
        "Market Crash Continuing",
        "Price dropped 15% but market is still crashing. EMA9 < EMA21, high sell pressure.",
        {
          symbol: "BTCUSDT",
          side: "LONG",
          entryPrice: 100000,
          closedAt: new Date(now - 40 * 60 * 1000).toISOString(), // 40 mins ago
        },
        85000, // 15% down
        "CRASH_CONTINUING",
        false, // Should BLOCK
      ),
    );

    // Scenario 2: Healthy Pullback - Should ALLOW
    results.push(
      this.runScenario(
        "Healthy Pullback with Recovery",
        "Price dropped 18% and now showing recovery signs. EMA9 > EMA21, strong buy volume.",
        {
          symbol: "BTCUSDT",
          side: "LONG",
          entryPrice: 100000,
          closedAt: new Date(now - 45 * 60 * 1000).toISOString(), // 45 mins ago
        },
        82000, // 18% down
        "HEALTHY_PULLBACK",
        true, // Should ALLOW
      ),
    );

    // Scenario 3: Cooldown Active - Should BLOCK
    results.push(
      this.runScenario(
        "Cooldown Period Active",
        "Good market conditions but closed only 15 minutes ago. Cooldown not met.",
        {
          symbol: "ETHUSDT",
          side: "LONG",
          entryPrice: 4000,
          closedAt: new Date(now - 15 * 60 * 1000).toISOString(), // 15 mins ago
        },
        3400, // 15% down
        "HEALTHY_PULLBACK",
        false, // Should BLOCK (cooldown)
      ),
    );

    // Scenario 4: Price Too Far - Should BLOCK
    results.push(
      this.runScenario(
        "Price Dropped Too Much",
        "Price dropped 30% (beyond 25% limit). Even with good signals, too risky.",
        {
          symbol: "BTCUSDT",
          side: "LONG",
          entryPrice: 100000,
          closedAt: new Date(now - 50 * 60 * 1000).toISOString(), // 50 mins ago
        },
        70000, // 30% down (too much)
        "HEALTHY_PULLBACK",
        false, // Should BLOCK (price range)
      ),
    );

    // Scenario 5: Price Too Close - Should BLOCK
    results.push(
      this.runScenario(
        "Price Too Close to Entry",
        "Price only dropped 3% (below 5% minimum). Not a good re-entry point.",
        {
          symbol: "BTCUSDT",
          side: "LONG",
          entryPrice: 100000,
          closedAt: new Date(now - 35 * 60 * 1000).toISOString(), // 35 mins ago
        },
        97000, // 3% down (too close)
        "SIDEWAYS",
        false, // Should BLOCK (price range)
      ),
    );

    // Scenario 6: Weak Bounce - Should BLOCK
    results.push(
      this.runScenario(
        "Weak Bounce with Low Volume",
        "Price dropped 12%, slight recovery but buy volume is weak (<55%).",
        {
          symbol: "BTCUSDT",
          side: "LONG",
          entryPrice: 100000,
          closedAt: new Date(now - 40 * 60 * 1000).toISOString(),
        },
        88000, // 12% down
        "WEAK_BOUNCE",
        false, // Should BLOCK (weak volume)
      ),
    );

    // Scenario 7: Strong Recovery - Should ALLOW
    results.push(
      this.runScenario(
        "Strong Recovery Signal",
        "Price dropped 20%, strong recovery started. EMA9 >> EMA21, very high buy volume.",
        {
          symbol: "BTCUSDT",
          side: "LONG",
          entryPrice: 100000,
          closedAt: new Date(now - 60 * 60 * 1000).toISOString(), // 60 mins ago
        },
        80000, // 20% down
        "STRONG_RECOVERY",
        true, // Should ALLOW
      ),
    );

    // Scenario 8: SHORT Position Crash Up - Should BLOCK
    results.push(
      this.runScenario(
        "SHORT Position - Price Pumping",
        "SHORT closed at $100k, price pumped to $115k (+15%). Market still pumping, no reversal.",
        {
          symbol: "BTCUSDT",
          side: "SHORT",
          entryPrice: 100000,
          closedAt: new Date(now - 45 * 60 * 1000).toISOString(),
        },
        115000, // 15% up (bad for SHORT)
        "CRASH_CONTINUING", // Inverted for SHORT
        false, // Should BLOCK
      ),
    );

    // Scenario 9: SHORT Position Good Reversal - Should ALLOW
    results.push(
      this.runScenario(
        "SHORT Position - Healthy Reversal",
        "SHORT closed at $100k, price pumped to $118k (+18%), now showing reversal signs.",
        {
          symbol: "BTCUSDT",
          side: "SHORT",
          entryPrice: 100000,
          closedAt: new Date(now - 50 * 60 * 1000).toISOString(),
        },
        118000, // 18% up
        "HEALTHY_PULLBACK", // Recovery = downtrend for SHORT
        true, // Should ALLOW
      ),
    );

    // Scenario 10: Sideways Market - Should BLOCK
    results.push(
      this.runScenario(
        "Sideways Choppy Market",
        "Price dropped 10% but market is choppy/sideways. No clear trend direction.",
        {
          symbol: "BTCUSDT",
          side: "LONG",
          entryPrice: 100000,
          closedAt: new Date(now - 35 * 60 * 1000).toISOString(),
        },
        90000, // 10% down
        "SIDEWAYS",
        false, // Should BLOCK (no clear trend)
      ),
    );

    // Summary
    console.log("\n" + "=".repeat(80));
    console.log("📊 TEST SUMMARY");
    console.log("=".repeat(80));
    const passed = results.filter((r) => r).length;
    const failed = results.length - passed;
    console.log(`Total Tests: ${results.length}`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(
      `Success Rate: ${((passed / results.length) * 100).toFixed(1)}%`,
    );
    console.log("=".repeat(80) + "\n");

    return {
      total: results.length,
      passed,
      failed,
      successRate: (passed / results.length) * 100,
    };
  }
}

// Run simulator if executed directly
if (require.main === module) {
  const simulator = new ReentrySafetySimulator();
  simulator.runAllTests();
}
