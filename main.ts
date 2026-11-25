// pump-bot: a paper-trading bot for the pump.fun replay (agent-fun/replay/v2).
//
// Hello, in plain terms: the harness sends a hello, then one batch per slot, and this bot
// answers each batch with the orders it wants. It never touches real money.
//
// What it does:
// - It keeps a short tape of the recent trades on every curve it sees.
// - It buys a coin only when the tape shows real buy pressure: enough trades in the window,
//   several distinct buyers, most of the SOL flowing in on the buy side, and the price up a
//   bit (but not already mooned) over the window.
// - Every position is sold whole on a stop loss, a take profit, a trailing stop, or a time
//   limit, whichever comes first. No position is left to ride into the ground.
// - If too few coins have completed a round trip, it also opens small "probe" round trips on
//   liquid, actively traded curves, so the run clears the guardrail of at least 20 coins with
//   a buy of at least 0.01 SOL each.
// - Stakes are small next to the 10 SOL of paper capital and at most 5 positions are open at
//   once, so no single bad coin can pull the account anywhere near the 50% drawdown limit.
//
// Deterministic: no clock, no Math.random, no environment reads. Everything is decided from
// the batch stream alone, in the order the batches and their events arrive.

import { LAMPORTS_PER_SOL, runBot, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

/** Total SOL put into one normal position. */
const STAKE_LAMPORTS = (SOL * 8n) / 100n; // 0.08 SOL
/** Total SOL put into one probe position (still above the 0.01 SOL round-trip minimum). */
const PROBE_LAMPORTS = (SOL * 2n) / 100n; // 0.02 SOL
/** Smallest normal buy worth sending after the reserve size cap bites. */
const MIN_MAIN_LAMPORTS = (SOL * 3n) / 100n; // 0.03 SOL

/** Slots of trade tape kept per curve (a slot is roughly 0.4 s, so this is about half a minute). */
const TAPE_SLOTS = 90;
/** Entry needs at least this many trades inside the tape window. */
const MIN_WINDOW_TRADES = 8;
/** Entry needs at least this many distinct buying wallets inside the window. */
const MIN_WINDOW_BUYERS = 4;
/** Buys must be at least this share of the window's traded SOL (in percent). */
const MIN_BUY_SHARE_PCT = 62;
/** Price must be up at least this much over the window to count as momentum (percent). */
const MIN_PRICE_UP_PCT = 2;
/** ...but not up more than this: a coin that already ran hard in one window is skipped. */
const MAX_PRICE_UP_PCT = 80;
/** Real SOL reserve bounds for an entry, in SOL: too thin is untradeable, too fat is nearly done. */
const MIN_RESERVE_SOL = 3;
const MAX_RESERVE_SOL = 90;

/** Sell everything when the position is worth this share of its cost (percent): the stop loss. */
const STOP_LOSS_PCT = 84;
/** Sell everything when the position is worth this share of its cost (percent): the take profit. */
const TAKE_PROFIT_PCT = 130;
/** Trailing stop arms at this share of cost (percent)... */
const TRAIL_ARM_PCT = 118;
/** ...and then sells when value falls to this share of its peak (percent). */
const TRAIL_DROP_PCT = 88;
/** Longest a normal position is held, in slots. */
const MAX_HOLD_SLOTS = 900;
/** Longest a probe position is held, in slots. Probes are there to complete a round trip. */
const PROBE_HOLD_SLOTS = 240;

/** Round trips to aim for (the guardrail asks for 20 coins; aim a little higher for slack). */
const TARGET_ROUND_TRIPS = 24;
/** A probe may open at most once per this many slots. */
const PROBE_EVERY_SLOTS = 120;
/** Probes only start once the run is this many slots in, so real signals get first pick. */
const PROBE_START_SLOTS = 600;
/** Most times one coin may be entered during the whole run. */
const MAX_ENTRIES_PER_MINT = 2;
/** Slots to wait after leaving a coin before it may be entered again. */
const REENTRY_COOLDOWN_SLOTS = 300;

const BUY_SLIPPAGE_BPS = 3000;
const SELL_SLIPPAGE_BPS = 10_000;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: string;
}

interface PriceSample {
  slot: number;
  price: number;
}

interface MintTape {
  trades: TapeTrade[];
  prices: PriceSample[];
  entries: number;
  lastExitSlot: number;
}

interface HeldPosition {
  entrySlot: number;
  probe: boolean;
  peakPct: number;
}

const tapes = new Map<Pubkey, MintTape>();
const held = new Map<Pubkey, HeldPosition>();
/** Kind of the buy most recently sent per mint, used to label the position when it lands. */
const buyKind = new Map<Pubkey, boolean>();
/** Coins that have completed at least one full round trip (bought, then sold out). */
const roundTripped = new Set<Pubkey>();

let firstSlot = -1;
let lastProbeSlot = -1;

function tapeFor(mint: Pubkey): MintTape {
  let tape = tapes.get(mint);
  if (tape === undefined) {
    tape = { trades: [], prices: [], entries: 0, lastExitSlot: -1 };
    tapes.set(mint, tape);
  }
  return tape;
}

/** Spot price from virtual reserves, as a plain ratio. Only used for comparisons. */
function spotPrice(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

/** What the held tokens would fetch at the curve's current spot price, in lamports. */
function spotValueLamports(tokenAmount: bigint, virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n) return 0n;
  return (tokenAmount * virtualQuote) / virtualToken;
}

function hasPending(state: { pending: Map<string, { order: { side: string; mint: Pubkey } }> }, mint: Pubkey, side: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

await runBot({
  onBatch(state, batch) {
    if (firstSlot < 0) firstSlot = batch.slot;
    const { caps } = state.hello;
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    const orders: OrderInput[] = [];

    // 1. Fold this batch's events into the tapes.
    const touched = new Set<Pubkey>();
    for (const e of batch.events) {
      touched.add(e.mint);
      if (e.event === 'CreateEvent') {
        tapeFor(e.mint);
      } else if (e.event === 'TradeEvent') {
        const tape = tapeFor(e.mint);
        tape.trades.push({ slot: batch.slot, buy: e.is_buy, sol: BigInt(e.sol_amount), user: e.user });
        const price = spotPrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (price > 0) tape.prices.push({ slot: batch.slot, price });
        const cutoff = batch.slot - TAPE_SLOTS;
        while (tape.trades.length > 0 && tape.trades[0].slot < cutoff) tape.trades.shift();
        while (tape.prices.length > 0 && tape.prices[0].slot < cutoff) tape.prices.shift();
      }
    }

    // 2. Sync the held map with the account the harness reports: new fills become positions,
    //    positions that are gone count as completed round trips.
    for (const [mint, pos] of state.positions) {
      if (!held.has(mint)) {
        held.set(mint, { entrySlot: batch.slot, probe: buyKind.get(mint) ?? false, peakPct: 100 });
        void pos;
      }
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) {
        held.delete(mint);
        roundTripped.add(mint);
        const tape = tapes.get(mint);
        if (tape !== undefined) tape.lastExitSlot = batch.slot;
      }
    }

    // 3. Exits first: a held position is sold whole on the first trigger that fires.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const info = held.get(mint);
      if (info === undefined) continue;
      if (hasPending(state, mint, 'sell')) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = spotValueLamports(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const valuePct = pos.cost_lamports > 0n ? Number((value * 100n) / pos.cost_lamports) : 100;
      if (valuePct > info.peakPct) info.peakPct = valuePct;
      const heldSlots = batch.slot - info.entrySlot;
      const maxHold = info.probe ? PROBE_HOLD_SLOTS : MAX_HOLD_SLOTS;
      const stopHit = valuePct <= STOP_LOSS_PCT;
      const takeHit = valuePct >= TAKE_PROFIT_PCT;
      const trailHit = info.peakPct >= TRAIL_ARM_PCT && valuePct <= (info.peakPct * TRAIL_DROP_PCT) / 100;
      const timeHit = heldSlots >= maxHold;
      if (stopHit || takeHit || trailHit || timeHit) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        free -= txFee;
      }
    }

    // 4. Entries: only coins this batch touched, in the order the batch touched them.
    let committed = state.committedPositionCount();
    for (const mint of touched) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (committed >= caps.max_open_positions) break;
      if (state.positions.has(mint) || hasPending(state, mint, 'buy')) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const tape = tapes.get(mint);
      if (tape === undefined) continue;
      if (tape.entries >= MAX_ENTRIES_PER_MINT) continue;
      if (tape.lastExitSlot >= 0 && batch.slot - tape.lastExitSlot < REENTRY_COOLDOWN_SLOTS) continue;

      const reserveSol = Number(curve.real_quote_reserves) / Number(SOL);
      if (reserveSol < MIN_RESERVE_SOL || reserveSol > MAX_RESERVE_SOL) continue;
      const sizeCap = state.maxBuyLamports(mint);
      if (sizeCap < PROBE_LAMPORTS) continue;

      // Window flow: who traded, which way the SOL went, and what the price did.
      let buySol = 0n;
      let sellSol = 0n;
      const buyers = new Set<string>();
      for (const t of tape.trades) {
        if (t.buy) {
          buySol += t.sol;
          buyers.add(t.user);
        } else {
          sellSol += t.sol;
        }
      }
      const totalSol = buySol + sellSol;
      const buySharePct = totalSol > 0n ? Number((buySol * 100n) / totalSol) : 0;
      let priceUpPct = 0;
      if (tape.prices.length >= 2) {
        const first = tape.prices[0].price;
        const last = tape.prices[tape.prices.length - 1].price;
        if (first > 0) priceUpPct = ((last - first) / first) * 100;
      }

      const momentum =
        tape.trades.length >= MIN_WINDOW_TRADES &&
        buyers.size >= MIN_WINDOW_BUYERS &&
        buySharePct >= MIN_BUY_SHARE_PCT &&
        priceUpPct >= MIN_PRICE_UP_PCT &&
        priceUpPct <= MAX_PRICE_UP_PCT;

      const probesDue =
        roundTripped.size + held.size < TARGET_ROUND_TRIPS &&
        batch.slot - firstSlot >= PROBE_START_SLOTS &&
        (lastProbeSlot < 0 || batch.slot - lastProbeSlot >= PROBE_EVERY_SLOTS) &&
        curve.trades >= 20;

      let amount: bigint | null = null;
      let probe = false;
      if (momentum) {
        amount = sizeCap < STAKE_LAMPORTS ? sizeCap : STAKE_LAMPORTS;
        if (amount < MIN_MAIN_LAMPORTS) amount = null;
      } else if (probesDue) {
        amount = PROBE_LAMPORTS;
        probe = true;
      }
      if (amount === null) continue;
      if (free < amount + txFee) continue;

      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + txFee;
      committed += 1;
      tape.entries += 1;
      buyKind.set(mint, probe);
      if (probe) lastProbeSlot = batch.slot;
    }

    return orders;
  },
});
