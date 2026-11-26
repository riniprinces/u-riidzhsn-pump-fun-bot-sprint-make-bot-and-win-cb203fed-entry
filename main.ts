// Pump.fun Bot Sprint: ride early momentum under a very wide trailing stop.
//
// Most pump.fun coins bleed out; a few run 3-10x. The dev data says the
// median coin drifts down after its first spike, while ~3% go 10x and ~9%
// go 3x. So this bot buys only coins that prove real early demand, risks a
// small fixed stake, and then gets out of the way: a 40% trailing stop lets
// a real runner breathe through its normal jagged pullbacks, a 10% hard
// stop caps the losers, and flat money is dumped after ~26 minutes unless
// it is already up 25%. There is no take-profit cap on purpose: the whole
// edge, such as it is, lives in the right tail. One buy per coin ever, so
// the stake spreads across many coins and the 20-distinct-mints guardrail
// stays reachable.
//
// A price is virtual SOL reserves over virtual token reserves. Every price
// comparison is a bigint cross-multiplication, so the bot is exactly
// deterministic: no clock, no environment, no randomness.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

// --- tunables ---------------------------------------------------------------
const STAKE = LAMPORTS_PER_SOL / 20n; // 0.05 SOL staked in each coin
const MIN_BUY = LAMPORTS_PER_SOL / 100n; // 0.01 SOL, the guardrail floor
const ENTER_RISE_BPS = 500; // buy once the price is +5% over its first trade
const ENTER_MAX_AGE = 600; // ...and the coin is younger than ~600 slots
const ENTER_MIN_TRADES = 3; // ...with at least 3 trades seen
const ENTER_MIN_BUY_VOL = LAMPORTS_PER_SOL / 5n; // ...and >= 0.20 SOL bought
const TRAIL_DROP_BPS = 4000; // sell 40% below the peak since entry
const STOP_DROP_BPS = 1000; // sell 10% below the entry price
const SLIPPAGE_BPS = 5000; // wide slippage: never lose a fill to a fast move
const FLAT_EXIT_SLOTS = 7200; // dump flat money after ~26 min unless up big
const FLAT_EXIT_RISE_BPS = 2500; // ...unless up 25%+ over entry

const BP_DENOM = 10000n;

/** Is price (aQ/aT) at least bps above price (bQ/bT)? */
function risesAtLeast(aQ: bigint, aT: bigint, bQ: bigint, bT: bigint, bps: bigint): boolean {
  return aQ * bT * (BP_DENOM + bps) > bQ * aT * BP_DENOM;
}

/** Is price (aQ/aT) at least bps below price (bQ/bT)? */
function fallsAtLeast(aQ: bigint, aT: bigint, bQ: bigint, bT: bigint, bps: bigint): boolean {
  return aQ * bT * BP_DENOM < bQ * aT * (BP_DENOM - bps);
}

/** Everything remembered about one coin, from its first sighting onward. */
interface Track {
  bornSlot: number;
  firstQuote: bigint;
  firstTokens: bigint;
  tradeCount: number;
  boughtQuote: bigint;
  soldQuote: bigint;
  entered: boolean;
  entryQuote: bigint;
  entryTokens: bigint;
  peakQuote: bigint;
  peakTokens: bigint;
  entrySlot: number;
}

function freshTrack(slot: number): Track {
  return {
    bornSlot: slot,
    firstQuote: 0n,
    firstTokens: 0n,
    tradeCount: 0,
    boughtQuote: 0n,
    soldQuote: 0n,
    entered: false,
    entryQuote: 0n,
    entryTokens: 0n,
    peakQuote: 0n,
    peakTokens: 0n,
    entrySlot: 0,
  };
}

/** True when a held position should be sold on this batch. */
function shouldSell(track: Track, quote: bigint, tokens: bigint, slot: number): boolean {
  // Only a real new high (>=3% over the old peak) moves the peak, so a coin
  // grinding sideways stops refreshing it and the flat-money rule can fire.
  if (risesAtLeast(quote, tokens, track.peakQuote, track.peakTokens, 300n)) {
    track.peakQuote = quote;
    track.peakTokens = tokens;
  }
  const trailed = fallsAtLeast(quote, tokens, track.peakQuote, track.peakTokens, BigInt(TRAIL_DROP_BPS));
  const stopped = fallsAtLeast(quote, tokens, track.entryQuote, track.entryTokens, BigInt(STOP_DROP_BPS));
  const flat = slot - track.entrySlot > FLAT_EXIT_SLOTS &&
    !risesAtLeast(quote, tokens, track.entryQuote, track.entryTokens, BigInt(FLAT_EXIT_RISE_BPS));
  return trailed || stopped || flat;
}

const book = new Map<string, Track>();

await runBot({
  onBatch(state, batch) {
    const orders: Array<BuyInput | SellInput> = [];
    const txFee = state.txFeeLamports();
    let cashLeft = state.freeCashLamports();
    let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();

    // Exits first: every held position gets its trailing stop, hard stop
    // and flat-money check against the latest reserves.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      const track = book.get(mint);
      if (curve === undefined || curve.complete || track === undefined) continue;
      const quote = curve.virtual_quote_reserves;
      const tokens = curve.virtual_token_reserves;
      if (tokens === 0n) continue;
      if (!shouldSell(track, quote, tokens, batch.slot)) continue;
      if (orders.length >= state.hello.caps.max_orders_per_batch) continue;
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SLIPPAGE_BPS,
      });
    }

    // Entries: scan this batch's events for fresh momentum.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!book.has(e.mint)) book.set(e.mint, freshTrack(e.slot));
        continue;
      }
      if (e.event !== 'TradeEvent') continue;
      const track = book.get(e.mint);
      const curve = state.curves.get(e.mint);
      if (track === undefined || curve === undefined || curve.complete) continue;
      if (track.firstQuote === 0n) {
        track.firstQuote = BigInt(e.virtual_quote_reserves);
        track.firstTokens = BigInt(e.virtual_token_reserves);
      }
      track.tradeCount += 1;
      if (e.is_buy) track.boughtQuote += BigInt(e.sol_amount);
      else track.soldQuote += BigInt(e.sol_amount);
      if (track.entered) continue;
      if (batch.slot - track.bornSlot > ENTER_MAX_AGE) continue;
      if (track.tradeCount < ENTER_MIN_TRADES) continue;
      if (track.boughtQuote < ENTER_MIN_BUY_VOL) continue;
      if (track.boughtQuote <= track.soldQuote) continue;
      const quote = curve.virtual_quote_reserves;
      const tokens = curve.virtual_token_reserves;
      if (tokens === 0n) continue;
      if (!risesAtLeast(quote, tokens, track.firstQuote, track.firstTokens, BigInt(ENTER_RISE_BPS))) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY) continue;
      if (orders.length >= state.hello.caps.max_orders_per_batch || openSlots <= 0) continue;
      const amount = cap < STAKE ? cap : STAKE;
      if (cashLeft < amount + txFee) continue;
      track.entered = true;
      track.entryQuote = quote;
      track.entryTokens = tokens;
      track.peakQuote = quote;
      track.peakTokens = tokens;
      track.entrySlot = batch.slot;
      orders.push({
        side: 'buy',
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      cashLeft -= amount + txFee;
      openSlots -= 1;
    }
    return orders;
  },
});
