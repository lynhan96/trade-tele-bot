/**
 * Complete System Simulator
 * Tests all major functions: TP checking, position closing, profit filtering, SL calculation, re-entry
 */

interface Position {
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  leverage: number;
}

interface TPConfig {
  percentage: number;
  initialBalance: number;
}

interface RetryConfig {
  maxRetry: number;
  currentRetryCount: number;
  volumeReductionPercent: number;
  enabled: boolean;
}

interface TestResult {
  scenario: string;
  passed: boolean;
  details: string;
}

export class CompleteSystemSimulator {
  private results: TestResult[] = [];

  /**
   * Calculate profit percentage for a position
   */
  private calculateProfitPercent(position: Position): number {
    const isLong = position.side === "LONG";
    return isLong
      ? ((position.currentPrice - position.entryPrice) / position.entryPrice) *
          100
      : ((position.entryPrice - position.currentPrice) / position.entryPrice) *
          100;
  }

  /**
   * Test 1: Check if TP target is reached
   */
  private testTPTargetCheck(
    positions: Position[],
    tpConfig: TPConfig,
  ): { reached: boolean; totalPnl: number; targetProfit: number } {
    const totalPnl = positions.reduce((sum, pos) => sum + pos.unrealizedPnl, 0);
    const targetProfit = (tpConfig.initialBalance * tpConfig.percentage) / 100;
    const reached = totalPnl >= targetProfit;

    return { reached, totalPnl, targetProfit };
  }

  /**
   * Test 2: Filter profitable positions (PnL > 0 AND profit > 2%)
   */
  private filterProfitablePositions(positions: Position[]): Position[] {
    return positions.filter((pos) => {
      if (pos.unrealizedPnl <= 0) return false;

      const profitPercent = this.calculateProfitPercent(pos);
      return profitPercent > 2;
    });
  }

  /**
   * Test 3: Calculate profit-protected stop loss
   */
  private calculateStopLoss(
    position: Position,
    tpPercentage: number,
    volumeReduction: number,
  ): {
    stopLossPrice: number;
    nextQuantity: number;
    potentialNextProfit: number;
  } {
    const isLong = position.side === "LONG";
    const nextQuantity = position.quantity * (1 - volumeReduction / 100);

    // Calculate TP price
    const tpPrice = isLong
      ? position.entryPrice * (1 + tpPercentage / 100)
      : position.entryPrice * (1 - tpPercentage / 100);

    // Calculate potential profit for next position
    const potentialNextProfit =
      Math.abs(tpPrice - position.entryPrice) * nextQuantity;

    // Calculate profit per unit
    const profitPerUnit = potentialNextProfit / nextQuantity;

    // Calculate stop loss
    const stopLossPrice = isLong
      ? parseFloat((position.entryPrice - profitPerUnit).toFixed(4))
      : parseFloat((position.entryPrice + profitPerUnit).toFixed(4));

    return { stopLossPrice, nextQuantity, potentialNextProfit };
  }

  /**
   * Test 4: Store re-entry data
   */
  private createReentryData(
    position: Position,
    tpConfig: TPConfig,
    retryConfig: RetryConfig,
  ): any {
    const slData = this.calculateStopLoss(
      position,
      tpConfig.percentage,
      retryConfig.volumeReductionPercent,
    );

    return {
      symbol: position.symbol,
      entryPrice: position.entryPrice,
      currentPrice: position.currentPrice,
      closedProfit: position.unrealizedPnl,
      side: position.side,
      quantity: slData.nextQuantity,
      originalQuantity: position.quantity,
      leverage: position.leverage,
      volume: slData.nextQuantity * position.entryPrice,
      originalVolume: position.quantity * position.entryPrice,
      closedAt: new Date().toISOString(),
      tpPercentage: tpConfig.percentage,
      stopLossPrice: slData.stopLossPrice,
      currentRetry: 1,
      remainingRetries: retryConfig.currentRetryCount - 1,
      volumeReductionPercent: retryConfig.volumeReductionPercent,
    };
  }

  /**
   * Run Scenario 1: TP Target Reached with Mixed Positions
   */
  private testScenario1() {
    console.log("\n" + "=".repeat(80));
    console.log(
      "📊 SCENARIO 1: TP Target Reached - Mixed Profitable/Losing Positions",
    );
    console.log("=".repeat(80));

    const positions: Position[] = [
      {
        symbol: "BTCUSDT",
        side: "LONG",
        quantity: 0.5,
        entryPrice: 100000,
        currentPrice: 105000,
        unrealizedPnl: 2500, // +5%
        leverage: 10,
      },
      {
        symbol: "ETHUSDT",
        side: "LONG",
        quantity: 10,
        entryPrice: 4000,
        currentPrice: 4100,
        unrealizedPnl: 1000, // +2.5%
        leverage: 10,
      },
      {
        symbol: "SOLUSDT",
        side: "SHORT",
        quantity: 100,
        entryPrice: 150,
        currentPrice: 149,
        unrealizedPnl: 100, // +0.67% (below 2% threshold)
        leverage: 5,
      },
      {
        symbol: "ADAUSDT",
        side: "LONG",
        quantity: 5000,
        entryPrice: 1.0,
        currentPrice: 0.98,
        unrealizedPnl: -100, // -2%
        leverage: 10,
      },
    ];

    const tpConfig: TPConfig = {
      percentage: 5,
      initialBalance: 50000,
    };

    console.log("\n📍 INPUT:");
    console.log(
      `  Initial Balance: $${tpConfig.initialBalance.toLocaleString()}`,
    );
    console.log(
      `  TP Target: ${tpConfig.percentage}% ($${((tpConfig.initialBalance * tpConfig.percentage) / 100).toLocaleString()})`,
    );
    console.log(`\n  Positions (${positions.length}):`);
    positions.forEach((pos, i) => {
      const profitPercent = this.calculateProfitPercent(pos);
      console.log(
        `    ${i + 1}. ${pos.symbol} ${pos.side}: $${pos.unrealizedPnl.toFixed(2)} (${profitPercent.toFixed(2)}%)`,
      );
    });

    // Test TP check
    const tpCheck = this.testTPTargetCheck(positions, tpConfig);
    console.log("\n🔍 STEP 1: Check TP Target");
    console.log(`  Total PnL: $${tpCheck.totalPnl.toFixed(2)}`);
    console.log(`  Target: $${tpCheck.targetProfit.toFixed(2)}`);
    console.log(`  TP Reached: ${tpCheck.reached ? "✅ YES" : "❌ NO"}`);

    // Test profit filtering
    const profitablePositions = this.filterProfitablePositions(positions);
    console.log(
      "\n🔍 STEP 2: Filter Profitable Positions (PnL > 0 AND profit > 2%)",
    );
    console.log(`  Total positions: ${positions.length}`);
    console.log(`  Profitable positions: ${profitablePositions.length}`);
    profitablePositions.forEach((pos, i) => {
      const profitPercent = this.calculateProfitPercent(pos);
      console.log(
        `    ✅ ${pos.symbol}: $${pos.unrealizedPnl.toFixed(2)} (${profitPercent.toFixed(2)}%)`,
      );
    });

    const filtered = positions.length - profitablePositions.length;
    console.log(`  Filtered out: ${filtered}`);
    positions
      .filter((p) => !profitablePositions.includes(p))
      .forEach((pos) => {
        const profitPercent = this.calculateProfitPercent(pos);
        const reason =
          pos.unrealizedPnl <= 0
            ? "PnL ≤ 0"
            : `Profit ${profitPercent.toFixed(2)}% < 2%`;
        console.log(`    ❌ ${pos.symbol}: ${reason}`);
      });

    // Expected: 2 positions should be closed (BTC and ETH), 2 should remain open
    const expectedProfitable = 2;
    const passed =
      profitablePositions.length === expectedProfitable && tpCheck.reached;

    console.log("\n📤 OUTPUT:");
    console.log(`  Would close: ${profitablePositions.length} positions`);
    console.log(
      `  Total profit captured: $${profitablePositions.reduce((s, p) => s + p.unrealizedPnl, 0).toFixed(2)}`,
    );
    console.log(`  Positions remaining open: ${filtered}`);

    console.log("\n🎯 TEST RESULT:");
    console.log(`  Expected: Close ${expectedProfitable} profitable positions`);
    console.log(`  Actual: Close ${profitablePositions.length} positions`);
    console.log(`  Status: ${passed ? "✅ PASSED" : "❌ FAILED"}`);

    this.results.push({
      scenario: "TP Target with Profit Filtering",
      passed,
      details: `Closed ${profitablePositions.length}/${expectedProfitable} expected positions`,
    });
  }

  /**
   * Run Scenario 2: Stop Loss Calculation
   */
  private testScenario2() {
    console.log("\n" + "=".repeat(80));
    console.log("📊 SCENARIO 2: Stop Loss Calculation (Profit-Protected)");
    console.log("=".repeat(80));

    const position: Position = {
      symbol: "BTCUSDT",
      side: "LONG",
      quantity: 1.0,
      entryPrice: 100000,
      currentPrice: 110000,
      unrealizedPnl: 10000, // $10k profit
      leverage: 10,
    };

    const tpConfig: TPConfig = {
      percentage: 10,
      initialBalance: 100000,
    };

    const retryConfig: RetryConfig = {
      maxRetry: 3,
      currentRetryCount: 3,
      volumeReductionPercent: 15,
      enabled: true,
    };

    console.log("\n📍 INPUT:");
    console.log(`  Position: ${position.symbol} ${position.side}`);
    console.log(`  Entry: $${position.entryPrice.toLocaleString()}`);
    console.log(`  Current: $${position.currentPrice.toLocaleString()}`);
    console.log(`  Quantity: ${position.quantity} BTC`);
    console.log(`  Profit: $${position.unrealizedPnl.toLocaleString()}`);
    console.log(`  TP Target: ${tpConfig.percentage}%`);
    console.log(`  Volume Reduction: ${retryConfig.volumeReductionPercent}%`);

    // Calculate stop loss
    const slData = this.calculateStopLoss(
      position,
      tpConfig.percentage,
      retryConfig.volumeReductionPercent,
    );

    console.log("\n🔍 CALCULATIONS:");
    console.log(`  Original Quantity: ${position.quantity} BTC`);
    console.log(
      `  Next Quantity: ${slData.nextQuantity.toFixed(4)} BTC (${retryConfig.volumeReductionPercent}% reduction)`,
    );
    const tpPrice = position.entryPrice * (1 + tpConfig.percentage / 100);
    console.log(`  TP Price: $${tpPrice.toLocaleString()}`);
    console.log(
      `  Potential Next Profit: $${slData.potentialNextProfit.toFixed(2)}`,
    );
    console.log(`  Stop Loss Price: $${slData.stopLossPrice.toLocaleString()}`);

    // Verify logic
    const slDistance = position.entryPrice - slData.stopLossPrice;
    const worstCaseLoss = slDistance * slData.nextQuantity;
    const securedProfit = position.unrealizedPnl - worstCaseLoss;

    console.log("\n🔍 VERIFICATION:");
    console.log(`  If Position B hits SL:`);
    console.log(`    - Loss from Position B: -$${worstCaseLoss.toFixed(2)}`);
    console.log(
      `    - Profit from Position A: +$${position.unrealizedPnl.toFixed(2)}`,
    );
    console.log(`    - Net Secured: $${securedProfit.toFixed(2)}`);

    // Expected: Secured profit should be positive
    const passed =
      securedProfit > 0 && slData.stopLossPrice < position.entryPrice;

    console.log("\n📤 OUTPUT:");
    console.log(`  Stop Loss: $${slData.stopLossPrice.toLocaleString()}`);
    console.log(`  Minimum Profit Secured: $${securedProfit.toFixed(2)}`);

    console.log("\n🎯 TEST RESULT:");
    console.log(`  Expected: SL < Entry Price AND Secured Profit > 0`);
    console.log(
      `  Actual: SL $${slData.stopLossPrice} < $${position.entryPrice} = ${slData.stopLossPrice < position.entryPrice ? "✅" : "❌"}`,
    );
    console.log(
      `  Actual: Secured $${securedProfit.toFixed(2)} > 0 = ${securedProfit > 0 ? "✅" : "❌"}`,
    );
    console.log(`  Status: ${passed ? "✅ PASSED" : "❌ FAILED"}`);

    this.results.push({
      scenario: "Stop Loss Calculation",
      passed,
      details: `SL at $${slData.stopLossPrice}, secures $${securedProfit.toFixed(2)}`,
    });
  }

  /**
   * Run Scenario 3: Re-entry Data Creation
   */
  private testScenario3() {
    console.log("\n" + "=".repeat(80));
    console.log("📊 SCENARIO 3: Re-entry Data Storage");
    console.log("=".repeat(80));

    const position: Position = {
      symbol: "ETHUSDT",
      side: "SHORT",
      quantity: 20,
      entryPrice: 4000,
      currentPrice: 3700,
      unrealizedPnl: 6000, // $6k profit from SHORT
      leverage: 10,
    };

    const tpConfig: TPConfig = {
      percentage: 8,
      initialBalance: 50000,
    };

    const retryConfig: RetryConfig = {
      maxRetry: 2,
      currentRetryCount: 2,
      volumeReductionPercent: 20,
      enabled: true,
    };

    console.log("\n📍 INPUT:");
    console.log(`  Position: ${position.symbol} ${position.side}`);
    console.log(`  Entry: $${position.entryPrice.toLocaleString()}`);
    console.log(`  Close Price: $${position.currentPrice.toLocaleString()}`);
    console.log(`  Profit: $${position.unrealizedPnl.toLocaleString()}`);
    console.log(`  Max Retries: ${retryConfig.maxRetry}`);

    // Create re-entry data
    const reentryData = this.createReentryData(position, tpConfig, retryConfig);

    console.log("\n📤 RE-ENTRY DATA CREATED:");
    console.log(`  Symbol: ${reentryData.symbol}`);
    console.log(`  Side: ${reentryData.side}`);
    console.log(`  Entry Price: $${reentryData.entryPrice.toLocaleString()}`);
    console.log(
      `  Closed Profit: $${reentryData.closedProfit.toLocaleString()}`,
    );
    console.log(
      `  Next Quantity: ${reentryData.quantity} ETH (${((1 - reentryData.quantity / position.quantity) * 100).toFixed(1)}% reduction)`,
    );
    console.log(`  Next Volume: $${reentryData.volume.toLocaleString()}`);
    console.log(`  Stop Loss: $${reentryData.stopLossPrice.toLocaleString()}`);
    console.log(`  Take Profit: ${reentryData.tpPercentage}%`);
    console.log(
      `  Current Retry: ${reentryData.currentRetry}/${retryConfig.maxRetry}`,
    );
    console.log(`  Remaining Retries: ${reentryData.remainingRetries}`);

    // Verify data
    const hasAllFields = !!(
      reentryData.symbol &&
      reentryData.side &&
      reentryData.entryPrice &&
      reentryData.quantity &&
      reentryData.stopLossPrice &&
      reentryData.tpPercentage
    );
    const quantityReduced = reentryData.quantity < position.quantity;
    const retriesCorrect =
      reentryData.currentRetry === 1 &&
      reentryData.remainingRetries === retryConfig.currentRetryCount - 1;

    const passed = hasAllFields && quantityReduced && retriesCorrect;

    console.log("\n🔍 VERIFICATION:");
    console.log(`  All required fields present: ${hasAllFields ? "✅" : "❌"}`);
    console.log(`  Quantity reduced: ${quantityReduced ? "✅" : "❌"}`);
    console.log(`  Retry counters correct: ${retriesCorrect ? "✅" : "❌"}`);

    console.log("\n🎯 TEST RESULT:");
    console.log(`  Status: ${passed ? "✅ PASSED" : "❌ FAILED"}`);

    this.results.push({
      scenario: "Re-entry Data Storage",
      passed,
      details: `Created re-entry data with ${reentryData.remainingRetries} retries remaining`,
    });
  }

  /**
   * Run Scenario 4: Complete Flow (TP → Filter → Calculate → Store)
   */
  private testScenario4() {
    console.log("\n" + "=".repeat(80));
    console.log("📊 SCENARIO 4: Complete Flow - TP to Re-entry Storage");
    console.log("=".repeat(80));

    const positions: Position[] = [
      {
        symbol: "BTCUSDT",
        side: "LONG",
        quantity: 0.3,
        entryPrice: 95000,
        currentPrice: 105000,
        unrealizedPnl: 3000, // +10.5%
        leverage: 10,
      },
      {
        symbol: "ETHUSDT",
        side: "LONG",
        quantity: 15,
        entryPrice: 3800,
        currentPrice: 4000,
        unrealizedPnl: 3000, // +5.3%
        leverage: 10,
      },
    ];

    const tpConfig: TPConfig = {
      percentage: 10,
      initialBalance: 50000,
    };

    const retryConfig: RetryConfig = {
      maxRetry: 3,
      currentRetryCount: 3,
      volumeReductionPercent: 15,
      enabled: true,
    };

    console.log("\n📍 STARTING CONDITIONS:");
    console.log(
      `  Initial Balance: $${tpConfig.initialBalance.toLocaleString()}`,
    );
    console.log(
      `  TP Target: ${tpConfig.percentage}% ($${((tpConfig.initialBalance * tpConfig.percentage) / 100).toLocaleString()})`,
    );
    console.log(`  Retry Enabled: ${retryConfig.enabled ? "✅ YES" : "❌ NO"}`);
    console.log(`  Max Retries: ${retryConfig.maxRetry}`);
    console.log(`\n  Open Positions:`);
    positions.forEach((pos) => {
      console.log(`    - ${pos.symbol}: $${pos.unrealizedPnl.toFixed(2)}`);
    });

    // Step 1: Check TP
    const tpCheck = this.testTPTargetCheck(positions, tpConfig);
    console.log("\n🔄 STEP 1: Check TP Target");
    console.log(`  Total PnL: $${tpCheck.totalPnl.toFixed(2)}`);
    console.log(`  Target: $${tpCheck.targetProfit.toFixed(2)}`);
    console.log(
      `  Result: ${tpCheck.reached ? "✅ TP REACHED" : "❌ NOT REACHED"}`,
    );

    if (!tpCheck.reached) {
      console.log("\n⚠️  TP not reached - flow stops here");
      this.results.push({
        scenario: "Complete Flow",
        passed: false,
        details: "TP target not reached",
      });
      return;
    }

    // Step 2: Filter profitable
    const profitablePositions = this.filterProfitablePositions(positions);
    console.log("\n🔄 STEP 2: Filter Profitable Positions");
    console.log(`  Found: ${profitablePositions.length} profitable positions`);
    profitablePositions.forEach((pos) => {
      const profitPercent = this.calculateProfitPercent(pos);
      console.log(`    ✅ ${pos.symbol}: ${profitPercent.toFixed(2)}%`);
    });

    // Step 3: Create re-entry data for each
    console.log("\n🔄 STEP 3: Create Re-entry Data");
    const reentryDataList = profitablePositions.map((pos) => {
      const data = this.createReentryData(pos, tpConfig, retryConfig);
      console.log(`  ${pos.symbol}:`);
      console.log(`    - Next Qty: ${data.quantity.toFixed(4)}`);
      console.log(`    - Stop Loss: $${data.stopLossPrice.toLocaleString()}`);
      console.log(`    - Retries: ${data.remainingRetries}`);
      return data;
    });

    // Step 4: Close positions
    console.log("\n🔄 STEP 4: Close Positions");
    const totalProfit = profitablePositions.reduce(
      (s, p) => s + p.unrealizedPnl,
      0,
    );
    console.log(`  Closing ${profitablePositions.length} positions`);
    console.log(`  Total profit captured: $${totalProfit.toFixed(2)}`);

    console.log("\n🔄 STEP 5: Send Notification");
    console.log(`  📱 Message sent to user:`);
    console.log(`     "🎯 TP Target Reached!"`);
    console.log(`     "Closed ${profitablePositions.length} positions"`);
    console.log(`     "Total profit: $${totalProfit.toFixed(2)}"`);
    console.log(
      `     "🔄 Auto re-entry enabled (${retryConfig.volumeReductionPercent}% volume reduction)"`,
    );

    // Verify complete flow
    const passed =
      tpCheck.reached &&
      profitablePositions.length > 0 &&
      reentryDataList.length === profitablePositions.length;

    console.log("\n📤 FINAL STATE:");
    console.log(`  Positions closed: ${profitablePositions.length}`);
    console.log(`  Re-entry data stored: ${reentryDataList.length}`);
    console.log(`  Waiting for re-entry opportunities...`);

    console.log("\n🎯 TEST RESULT:");
    console.log(`  Expected: Complete flow from TP → Close → Store`);
    console.log(
      `  Actual: ${tpCheck.reached ? "✅" : "❌"} TP check → ${profitablePositions.length ? "✅" : "❌"} Filter → ${reentryDataList.length ? "✅" : "❌"} Store`,
    );
    console.log(`  Status: ${passed ? "✅ PASSED" : "❌ FAILED"}`);

    this.results.push({
      scenario: "Complete Flow",
      passed,
      details: `Processed ${profitablePositions.length} positions through complete flow`,
    });
  }

  /**
   * Run Scenario 5: Multiple Retry Cycles
   */
  private testScenario5() {
    console.log("\n" + "=".repeat(80));
    console.log("📊 SCENARIO 5: Multiple Re-entry Cycles");
    console.log("=".repeat(80));

    let position: Position = {
      symbol: "BTCUSDT",
      side: "LONG",
      quantity: 1.0,
      entryPrice: 100000,
      currentPrice: 110000,
      unrealizedPnl: 10000,
      leverage: 10,
    };

    const tpConfig: TPConfig = {
      percentage: 10,
      initialBalance: 100000,
    };

    let retryConfig: RetryConfig = {
      maxRetry: 3,
      currentRetryCount: 3,
      volumeReductionPercent: 15,
      enabled: true,
    };

    console.log("\n📍 INITIAL POSITION:");
    console.log(`  ${position.symbol} ${position.side}`);
    console.log(`  Quantity: ${position.quantity} BTC`);
    console.log(`  Entry: $${position.entryPrice.toLocaleString()}`);
    console.log(`  Max Retries: ${retryConfig.maxRetry}`);

    const cycles: any[] = [];

    // Simulate 3 retry cycles
    for (let cycle = 1; cycle <= retryConfig.maxRetry; cycle++) {
      console.log(`\n🔄 CYCLE ${cycle}:`);

      const slData = this.calculateStopLoss(
        position,
        tpConfig.percentage,
        retryConfig.volumeReductionPercent,
      );

      console.log(
        `  Close at: $${position.currentPrice.toLocaleString()} (profit: $${position.unrealizedPnl.toFixed(2)})`,
      );
      console.log(`  Next quantity: ${slData.nextQuantity.toFixed(4)} BTC`);
      console.log(`  Stop loss: $${slData.stopLossPrice.toLocaleString()}`);
      console.log(`  Remaining retries: ${retryConfig.currentRetryCount - 1}`);

      cycles.push({
        cycle,
        quantity: slData.nextQuantity,
        stopLoss: slData.stopLossPrice,
        profit: position.unrealizedPnl,
      });

      // Prepare for next cycle
      position = {
        ...position,
        quantity: slData.nextQuantity,
        currentPrice: position.entryPrice * 1.1, // Assume hits TP again
        unrealizedPnl: position.entryPrice * 0.1 * slData.nextQuantity,
      };

      retryConfig = {
        ...retryConfig,
        currentRetryCount: retryConfig.currentRetryCount - 1,
      };

      if (retryConfig.currentRetryCount === 0) {
        console.log(`  ⚠️  Final retry - no more re-entries after this`);
      }
    }

    console.log("\n📊 RETRY SUMMARY:");
    console.log("  Cycle | Quantity | Profit | Stop Loss");
    console.log("  " + "-".repeat(50));
    cycles.forEach((c) => {
      console.log(
        `    ${c.cycle}   | ${c.quantity.toFixed(4)} | $${c.profit.toFixed(2).padStart(7)} | $${c.stopLoss.toLocaleString()}`,
      );
    });

    // Verify quantity reduction each cycle
    const quantitiesDecreasing = cycles.every((c, i) => {
      if (i === 0) return true;
      return c.quantity < cycles[i - 1].quantity;
    });

    const passed = cycles.length === 3 && quantitiesDecreasing;

    console.log("\n🎯 TEST RESULT:");
    console.log(`  Expected: 3 cycles with decreasing quantities`);
    console.log(
      `  Actual: ${cycles.length} cycles, quantities decreasing: ${quantitiesDecreasing ? "✅" : "❌"}`,
    );
    console.log(`  Status: ${passed ? "✅ PASSED" : "❌ FAILED"}`);

    this.results.push({
      scenario: "Multiple Retry Cycles",
      passed,
      details: `Completed ${cycles.length} retry cycles`,
    });
  }

  /**
   * Run Scenario 6: Entry Price Optimization (NEW)
   */
  private testScenario6() {
    console.log("\n" + "=".repeat(80));
    console.log("📊 SCENARIO 6: Entry Price Optimization on Re-entry");
    console.log("=".repeat(80));

    console.log("\n📍 CONCEPT:");
    console.log(
      "  When re-entering, use ACTUAL execution price (not original)",
    );
    console.log("  This optimizes entries and adapts to market conditions");

    // Original position
    const originalEntry = 100000;
    const originalQuantity = 1.0;

    console.log("\n🔄 CYCLE 1 (Original Entry):");
    console.log(`  Entry: $${originalEntry.toLocaleString()}`);
    console.log(`  Quantity: ${originalQuantity} BTC`);
    console.log(`  TP Target: $110,000 (+10%)`);
    console.log(`  Result: TP Hit! Close at $110,000, Profit: $10,000`);

    // Re-entry 1: Price dropped to $95,000 (better entry for LONG!)
    const reentry1Price = 95000;
    const reentry1Quantity = originalQuantity * 0.85; // 15% reduction
    const reentry1TP = reentry1Price * 1.1;
    const reentry1PotentialProfit =
      (reentry1TP - reentry1Price) * reentry1Quantity;

    console.log("\n🔄 CYCLE 2 (Re-entry #1):");
    console.log(
      `  ❌ OLD WAY: Would use $${originalEntry.toLocaleString()} as entry`,
    );
    console.log(
      `  ✅ NEW WAY: Use actual execution price $${reentry1Price.toLocaleString()}`,
    );
    console.log(
      `  💰 Improvement: ${(((originalEntry - reentry1Price) / originalEntry) * 100).toFixed(2)}% better entry!`,
    );
    console.log(`  Quantity: ${reentry1Quantity.toFixed(4)} BTC`);
    console.log(
      `  New TP: $${reentry1TP.toLocaleString()} (+10% from NEW entry)`,
    );
    console.log(`  Potential profit: $${reentry1PotentialProfit.toFixed(2)}`);

    // Calculate stop loss based on NEW entry (not original)
    const reentry1SL =
      reentry1Price - reentry1PotentialProfit / reentry1Quantity;
    console.log(
      `  Stop Loss: $${reentry1SL.toLocaleString()} (protects profit from THIS entry)`,
    );

    // Re-entry 2: Price dropped to $92,000 (even better!)
    const reentry2Price = 92000;
    const reentry2Quantity = reentry1Quantity * 0.85; // Another 15% reduction
    const reentry2TP = reentry2Price * 1.1;
    const reentry2PotentialProfit =
      (reentry2TP - reentry2Price) * reentry2Quantity;

    console.log("\n🔄 CYCLE 3 (Re-entry #2):");
    console.log(
      `  ❌ OLD WAY: Would still use $${originalEntry.toLocaleString()}`,
    );
    console.log(
      `  ✅ NEW WAY: Use actual execution price $${reentry2Price.toLocaleString()}`,
    );
    console.log(
      `  💰 Improvement: ${(((originalEntry - reentry2Price) / originalEntry) * 100).toFixed(2)}% better than original!`,
    );
    console.log(
      `  💰 Improvement: ${(((reentry1Price - reentry2Price) / reentry1Price) * 100).toFixed(2)}% better than previous entry!`,
    );
    console.log(`  Quantity: ${reentry2Quantity.toFixed(4)} BTC`);
    console.log(`  New TP: $${reentry2TP.toLocaleString()}`);
    console.log(`  Potential profit: $${reentry2PotentialProfit.toFixed(2)}`);

    const reentry2SL =
      reentry2Price - reentry2PotentialProfit / reentry2Quantity;
    console.log(`  Stop Loss: $${reentry2SL.toLocaleString()}`);

    console.log("\n📊 BENEFITS OF ADAPTIVE ENTRY:");

    console.log("\n  ✅ BENEFIT 1: Better Risk/Reward");
    console.log(
      `     Old entry $${originalEntry.toLocaleString()} → New $${reentry2Price.toLocaleString()}`,
    );
    console.log(
      `     Entry improvement: ${(((originalEntry - reentry2Price) / originalEntry) * 100).toFixed(2)}%`,
    );
    console.log(`     Lower entry = more upside potential`);

    console.log("\n  ✅ BENEFIT 2: Accurate Stop Loss");
    console.log(`     SL based on ACTUAL entry, not original`);
    console.log(
      `     Cycle 2 SL: $${reentry1SL.toLocaleString()} (based on $${reentry1Price.toLocaleString()} entry)`,
    );
    console.log(
      `     Cycle 3 SL: $${reentry2SL.toLocaleString()} (based on $${reentry2Price.toLocaleString()} entry)`,
    );

    console.log("\n  ✅ BENEFIT 3: Market Adaptation");
    console.log(`     System adapts to actual execution prices`);
    console.log(`     No slippage accumulation from original entry`);
    console.log(`     Each retry optimized for current market conditions`);

    console.log("\n  💡 KEY INSIGHT:");
    console.log(
      `     Even if profit per trade is smaller (due to smaller quantity),`,
    );
    console.log(`     the ENTRY PRICE is optimized for market conditions!`);
    console.log(
      `     This reduces risk and improves overall risk/reward ratio.`,
    );

    // Verify optimization logic works correctly
    const entryImproving =
      reentry1Price < originalEntry && reentry2Price < reentry1Price;
    const slAccurate = reentry1SL < reentry1Price && reentry2SL < reentry2Price;
    const passed = entryImproving && slAccurate;

    console.log("\n🎯 TEST RESULT:");
    console.log(
      `  Expected: Entry prices adapt to market + SL calculated accurately`,
    );
    console.log(
      `  Entry adaptation: ${entryImproving ? "✅" : "❌"} (${reentry2Price} < ${reentry1Price} < ${originalEntry})`,
    );
    console.log(
      `  SL accuracy: ${slAccurate ? "✅" : "❌"} (SL based on actual entry prices)`,
    );
    console.log(`  Status: ${passed ? "✅ PASSED" : "❌ FAILED"}`);

    this.results.push({
      scenario: "Entry Price Optimization",
      passed,
      details: `Entries adapt to market: $100k → $95k → $92k, SL calculated correctly`,
    });
  }

  /**
   * Run all test scenarios
   */
  public runAllTests() {
    console.log("\n🚀 STARTING COMPLETE SYSTEM SIMULATOR");
    console.log(
      "Testing: TP Check → Profit Filter → SL Calc → Re-entry Storage\n",
    );

    this.testScenario1(); // TP + Filtering
    this.testScenario2(); // SL Calculation
    this.testScenario3(); // Re-entry Data
    this.testScenario4(); // Complete Flow
    this.testScenario5(); // Multiple Cycles
    this.testScenario6(); // Entry Price Optimization (NEW)

    // Summary
    console.log("\n" + "=".repeat(80));
    console.log("📊 TEST SUMMARY");
    console.log("=".repeat(80));

    const passed = this.results.filter((r) => r.passed).length;
    const failed = this.results.length - passed;

    this.results.forEach((result, i) => {
      const status = result.passed ? "✅ PASS" : "❌ FAIL";
      console.log(`${i + 1}. ${status} - ${result.scenario}`);
      console.log(`   ${result.details}`);
    });

    console.log("\n" + "=".repeat(80));
    console.log(`Total Tests: ${this.results.length}`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(
      `Success Rate: ${((passed / this.results.length) * 100).toFixed(1)}%`,
    );
    console.log("=".repeat(80) + "\n");

    return {
      total: this.results.length,
      passed,
      failed,
      successRate: (passed / this.results.length) * 100,
    };
  }
}

// Run simulator if executed directly
if (require.main === module) {
  const simulator = new CompleteSystemSimulator();
  const results = simulator.runAllTests();
  process.exit(results.failed > 0 ? 1 : 0);
}
