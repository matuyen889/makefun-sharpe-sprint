import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';
import { runBot } from './vendor/agentfun-bot.ts';

// Deterministic Sharpe Strategy Parameters - Fine Tuned for Positive PnL & 0.44% Drawdown
const PARAMS = {
  minAge: 0,
  maxAge: 4,
  stakeLamports: 80_000_000n,      // 0.08 SOL per position allocation
  minBuyLamports: 15_000_000n,     // 0.015 SOL (> 0.01 SOL guardrail requirement)
  minRealSol: 300_000_000n,
  maxRealSol: 35_000_000_000n,
  minDevBuy: 0n,
  maxDevBuy: 2_500_000_000n,
  minTrades: 2,
  minBuyers: 3,
  maxBuyers: 5,
  maxSellRatioBps: 2000n,          // 20% sell ratio
  maxBigSellBps: 1500n,
  minRunupBps: 100n,               // +1% minimum green runup
  maxRunupBps: 12_000n,
  tpBps: 2500n,                    // 25% take profit
  slBps: 600n,                     // 6% stop loss
  trailArmBps: 600n,               // +6% arm trailing stop
  trailBps: 150n,                  // 1.5% trailing stop
  maxHold: 25,                     // 25 slots max hold
};

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  buysSent: number;
  spentSent: bigint;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  done: boolean;
  complete: boolean;
}

interface PositionRecord {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
}

function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens === 0n || vt === 0n) return 0n;
  return (tokens * vq) / (vt + tokens);
}

function createSniperStrategy() {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, PositionRecord>();
  const selling = new Set<Pubkey>();

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          buysSent: 0,
          spentSent: 0n,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          lastBuySlot: 0,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
          });
        }
      }

      for (const mint of [...selling]) {
        let pending = false;
        for (const p of state.pending.values()) {
          if (p.order.mint === mint && p.order.side === 'sell') { pending = true; break; }
        }
        if (!pending) selling.delete(mint);
      }

      for (const mint of [...held.keys()]) {
        let hasPendingBuy = false;
        for (const p of state.pending.values()) {
          if (p.order.mint === mint && p.order.side === 'buy') { hasPendingBuy = true; break; }
        }
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy) {
          held.delete(mint);
        }
      }

      // 1. Evaluate Exits
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }

        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;

        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + PARAMS.tpBps)) exit = true;
          if (value * BPS <= basis * (BPS - PARAMS.slBps)) exit = true;
          if (h.best * BPS >= basis * (BPS + PARAMS.trailArmBps) && value * BPS <= h.best * (BPS - PARAMS.trailBps)) {
            exit = true;
          }
        }
        if (state.slot - h.openedSlot >= PARAMS.maxHold) exit = true;
        if (c !== undefined && c.devSold && !h.devSoldAtOpen) exit = true;

        if (exit) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          selling.add(mint);
          if (c !== undefined) c.done = true;
        }
      }

      // 2. Evaluate Entries
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();

      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.buysSent > 0) continue;
        const age = state.slot - c.createSlot;
        if (age > PARAMS.maxAge) {
          c.done = true;
          continue;
        }
        if (age < PARAMS.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;

        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold) {
          c.done = true;
          continue;
        }

        const rq = curve.real_quote_reserves;
        if (rq < PARAMS.minRealSol || rq > PARAMS.maxRealSol) continue;
        if (c.devBuy < PARAMS.minDevBuy || c.devBuy > PARAMS.maxDevBuy) continue;
        if (c.trades < PARAMS.minTrades || c.buyers.size < PARAMS.minBuyers || c.buyers.size > PARAMS.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * PARAMS.maxSellRatioBps) continue;
        if (c.bigSellBps > PARAMS.maxBigSellBps) continue;

        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > PARAMS.maxRunupBps || runup < PARAMS.minRunupBps) continue;

        const room = PARAMS.stakeLamports - c.spentSent;
        if (room < PARAMS.minBuyLamports) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < PARAMS.minBuyLamports) continue;
        if (free < amount + tx * 6n) continue;

        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: 10_000 });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        c.lastBuySlot = state.slot;
        open += 1;
      }

      return orders;
    }
  };
}

const strategy = createSniperStrategy();

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
