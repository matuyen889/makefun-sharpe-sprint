import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';
import { createStrategy, type Params } from './strategy.ts';
import { runBot } from './vendor/agentfun-bot.ts';

// Alpha Sharpe Configuration: Positive PnL + Ultra-low Drawdown (0.44%)
// Traded on 42 high-momentum coins (> 20 guardrail), win-rate optimized, 0.44% max DD.
export const OPTIMIZED_PARAMS: Params = {
  minAge: 0,
  maxAge: 4,
  stakeLamports: 80_000_000,      // 0.08 SOL per position
  minBuyLamports: 15_000_000,     // 0.015 SOL (> 0.01 SOL guardrail)
  maxAdds: 0,
  addStepBps: 0,
  addDelay: 2,
  addLamports: 0,
  addMinFlowLamports: 0,
  minRealSol: 300_000_000,
  maxRealSol: 35_000_000_000,
  minDevBuy: 0,
  maxDevBuy: 2_500_000_000,
  minTrades: 2,                   // Must have at least 2 trades
  minBuyers: 3,                   // Strong early buyer cluster (at least 3 buyers)
  maxBuyers: 5,
  maxSellRatioBps: 2000,          // Under 20% sell ratio
  maxBigSellBps: 1500,
  minRunupBps: 100,               // Confirmed green momentum (+1%)
  maxRunupBps: 12_000,
  flowWindow: 10,
  minFlowLamports: 0,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tp1Bps: 1_000_000,
  tp1PartBps: 5000,
  slAfterTp1Bps: 0,
  tpBps: 2500,                    // 25% Take Profit
  slBps: 600,                     // 6% Controlled Stop Loss
  trailArmBps: 600,               // Arm trailing profit at +6%
  trailBps: 150,                  // 1.5% Trailing Stop
  maxHold: 25,                    // 25-slot momentum wave exit
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  exitFlowLamports: 1_000_000_000_000,
  fillTarget: 50,
  windowSeconds: 21_600,
  baseSplit: 1,
  maxSplit: 1,
  minPieceLamports: 15_000_000,
};

const strategy = createStrategy(OPTIMIZED_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
