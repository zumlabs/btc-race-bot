// cbBTC panic-dip bot for the make.fun 24h race (agent-fun/bars-replay/v1).
//
// One asset, long only, and a full-size round trip costs about 30 bps once the 4 bps fee each way,
// the 2 bps modelled slippage and the pool impact at the recorded depth are paid. A slow directional
// signal has to be right for hours to clear that; a panic dip has a shorter, larger payoff. So the
// bot waits for a genuine selloff — a fresh 2.1% drawdown from the highest close of the last four
// hours — buys it in two legs one bar apart, and takes the bounce.
//
// A fresh cross, not a level: after a stop or a target the price is often still under the band, and
// re-buying the same dip every bar would pay the round trip again and again. Requiring the price to
// recover above the band and fall through it once more makes each entry a new event.
//
// Exits, in the order they matter: a 2% hard stop under the average fill; a 0.4% trail under the
// peak close once the trade is 1.5% in profit (a runner's trail, armed only with something to
// protect); a quick +0.8% target while the trade is young, because a panic bounce either pays fast
// or fails; and a 12-hour time stop. Every exit is followed by a 60-bar cooldown.
//
// Deterministic: float64 on + - * / only, no clock, no randomness, no I/O beyond the protocol. Every
// order carries max_slippage_bps 150, far past a normal fill's move from the close, so only a true
// liquidity gap refuses one.

import { runBars, type BarsState, type Bar, type OrderInput } from './vendor/makefun-bars.ts';

const BPS = 10_000;
const SLIP_BPS = 150;
/** Four hours of one-minute closes: long enough that one print cannot set the high. */
const LOOKBACK_BARS = 240;
/** A 2.10% drawdown from that high is a selloff worth buying (the middle of a stable 2.0-2.2% band). */
const DIP_BPS = 210;
/** Two legs, one open each: 49% of cash now, 98% of what is left on the next bar. */
const FIRST_LEG = 0.49;
const SECOND_LEG = 0.98;
/** Bank a fast bounce while the trade is young. */
const BOUNCE_BPS = 80;
const BOUNCE_BARS = 180;
/** A runner's trail: armed at +1.5%, then 0.40% under the peak close. */
const TRAIL_ARM_BPS = 150;
const TRAIL_BPS = 40;
/** Hard stop under the average fill, and the longest a trade may sit. */
const STOP_BPS = 200;
const MAX_HOLD_BARS = 720;
/** Bars to wait after any exit before a new crossing may be bought. */
const COOLDOWN_BARS = 60;
const MIN_NOTIONAL = 1_000_000;

interface Book {
  fill: number; // average fill of the legs
  qty: number; // units held, for the average
  peak: number; // highest close since the entry
  bars: number; // bars held
}

const book: Book = { fill: 0, qty: 0, peak: 0, bars: 0 };
const closes: number[] = [];
/** The previous bar's close / high - 1, for the fresh-cross test. */
let priorDrawdown = 0;
let cooldown = 0;
/** The entry's second leg is owed on the batch after the first fill. */
let secondLegOwed = false;

/** The highest close of the last LOOKBACK_BARS bars, this one included. */
function highestClose(): number {
  let high = -Infinity;
  const start = closes.length > LOOKBACK_BARS ? closes.length - LOOKBACK_BARS : 0;
  for (let i = start; i < closes.length; i++) if (closes[i] > high) high = closes[i];
  return high;
}

function buy(symbol: string, notional: number): OrderInput {
  return { side: 'buy', symbol, notional_quote_units: BigInt(notional), max_slippage_bps: SLIP_BPS };
}

await runBars({
  onBatch(state: BarsState, batch): OrderInput[] {
    const symbol = state.hello.symbols[0]?.symbol;
    if (symbol === undefined) return [];
    const bar: Bar | undefined = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    if (!(close > 0)) return [];

    closes.push(close);
    if (cooldown > 0) cooldown--;

    // Fills from the previous reply.
    for (const f of batch.fills) {
      if (f.symbol !== symbol) continue;
      if (f.status !== 'filled') {
        if (f.side === 'buy' && book.qty === 0) secondLegOwed = false;
        continue;
      }
      if (f.side === 'buy') {
        const price = Number(f.price);
        const qty = Number(f.qty);
        const held = book.qty + qty;
        book.fill = held > 0 ? (book.fill * book.qty + price * qty) / held : price;
        book.qty = held;
        book.peak = book.peak > close ? book.peak : close;
      } else {
        book.fill = 0;
        book.qty = 0;
        book.peak = 0;
        book.bars = 0;
        cooldown = COOLDOWN_BARS;
      }
    }

    const pos = state.positions.get(symbol);
    const inPosition = pos !== undefined && pos.qty > 0n;

    // The second leg of a fresh entry fills one bar after the first, while the position is open.
    if (secondLegOwed) {
      secondLegOwed = false;
      if (inPosition) {
        const notional = Math.floor(Number(state.cash) * SECOND_LEG);
        if (notional >= MIN_NOTIONAL) return [buy(symbol, notional)];
        return [];
      }
    }

    if (inPosition) {
      if (book.fill <= 0) book.fill = close;
      if (book.peak <= 0) book.peak = close;
      if (close > book.peak) book.peak = close;
      book.bars++;

      const profit = close / book.fill - 1;
      const stopHit = close <= book.fill * (1 - STOP_BPS / BPS);
      const trailArmed = book.peak >= book.fill * (1 + TRAIL_ARM_BPS / BPS);
      const trailHit = trailArmed && close <= book.peak * (1 - TRAIL_BPS / BPS);
      const bounceHit = book.bars <= BOUNCE_BARS && profit >= BOUNCE_BPS / BPS;
      const timedOut = book.bars >= MAX_HOLD_BARS;
      if (stopHit || trailHit || bounceHit || timedOut) {
        return [{ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: SLIP_BPS }];
      }
      return [];
    }

    const high = highestClose();
    if (!(high > 0)) {
      priorDrawdown = 0;
      return [];
    }
    const drawdown = close / high - 1;
    const freshCross = priorDrawdown > -DIP_BPS / BPS && drawdown <= -DIP_BPS / BPS;
    priorDrawdown = drawdown;

    if (!freshCross || cooldown > 0 || state.warmingUp) return [];

    const notional = Math.floor(Number(state.cash) * FIRST_LEG);
    if (notional < MIN_NOTIONAL) return [];
    secondLegOwed = true;
    return [buy(symbol, notional)];
  },
});
