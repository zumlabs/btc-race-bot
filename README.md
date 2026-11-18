# btc-race-bot

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/zumlabs/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/zumlabs/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

A long-only, single-position cbBTC bot for the make.fun 24-hour BTC race
(`agent-fun/bars-replay/v1`). It starts with 1,000 USDC of paper money and trades one-minute bars of
Coinbase Wrapped BTC against USDC, replayed from the Orca Whirlpool the kit freezes.

## Strategy

A full-size round trip pays about 30 bps (4 bps fee each way, 2 bps modelled slippage, and the pool
impact at the bar's recorded depth). A slow directional signal must be right for hours to clear
that; a panic dip has a shorter, larger payoff. So the bot trades selloffs instead of trends:

- **Regime** — the close against the highest close of the last 240 bars (four hours).
- **Entry** — a *fresh* crossing below a 2.1% drawdown from that high. The price must recover above
  the band and fall through it again before another entry, so a stop or a target does not lead
  straight back into the same dip. The entry is spread over two opens: 49% of cash, then 98% of what
  is left on the next bar.
- **Exits** — a 2% hard stop under the average fill; a 0.4% trail under the peak close once the
  trade is 1.5% in profit; a +0.8% target while the trade is young (a panic bounce pays fast or
  fails); and a 12-hour time stop. A 60-bar cooldown follows every exit.

On the published dev window this makes 6 fills, +22.80 USDC (+2.28%), a 0.64% maximum drawdown and
1.60 USDC of fees, with both graded runs byte-identical. The 2.1% band is the middle of the range
that was graded end to end: 2.0% and 2.2% grade at +22.41 and +24.15 USDC too, so the result is a
plateau rather than a point.

The bot is deterministic: float64 on `+ - * /` only, no clock, no randomness, no files. Every order
carries `max_slippage_bps: 150`.

## Run

Node 22 or later, no dependencies beyond the standard library and the vendored protocol shim:

```sh
node main.ts
```

The process speaks the protocol on stdin/stdout: one `hello`, one `batch` per minute, then `done`,
with exactly one reply per batch. `vendor/makefun-bars.ts` is a byte-for-byte copy of the kit's SDK
shim and owns the wire; `main.ts` only decides the orders.

## Grade locally

From the unpacked kit directory, pointing `--bot` at this repository:

```sh
node cli/makefun.mjs grade-local --kit . \
  --bot /path/to/btc-race-bot --worktree --driver process
```

The kit runs the bot twice on the dev window and requires the two action logs to match byte for
byte; `--driver docker` uses the server's sandbox when Docker is available. A grade is only a gate:
the race window is graded separately, after the deadline.

## License

MIT. See [LICENSE](LICENSE).
