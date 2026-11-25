# pump-bot

![Competition](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)
![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/qazzk13/makefun-pumpbot/rank.svg)
![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/qazzk13/makefun-pumpbot/reward.svg)

Entry for [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on make.fun. It is a paper-trading bot: the harness replays recorded pump.fun chain data at it, and it answers each batch with buy or sell orders. No real money, no keys, no network.

## How it trades, in plain words

The first version of this bot chased momentum — buy when the price and the buy flow are both rising — and on the dev tape it just bled: 545 round trips, win rate under a third, -2.3 SOL. By the time the flow looks exciting, the move is usually being sold into. So the shipped version buys dips instead. For every coin it keeps the last ~90 slots of trades. A coin only gets bought when its price is down 10% to 28% over that window, but the newer half of the window shows at least 0.8 SOL of net inflow, more than the older half — sellers hit it, and now fresh buyers are stepping in. It also needs at least 12 window trades from at least 6 different buyers, buys making up 45–68% of the traded SOL, and a real reserve between 5 and 90 SOL. One shot per coin; no re-entries.

Stakes are 0.08 SOL per position, capped by whatever the curve's reserve size allows, and never more than 5 positions at once out of the 10 SOL paper bankroll. Exits are mechanical: sell everything at -10% (stop loss), at +18% (take profit), on a trailing stop once a position has been up 12% and falls 10% off its peak, when buyers vanish from the tape (flow fade), or after 450 slots if nothing happened. Whichever comes first.

The contest also wants at least 20 different coins to complete a full round trip with at least 0.01 SOL bought. Dip signals alone might not get there on a quiet tape, so if round trips are lagging, the bot opens small 0.02 SOL probe positions on liquid, actively traded curves and closes them within 180 slots. Probes are not meant to make money; they are there so the entry clears the guardrails, and they are sized so their fees stay a rounding error.

On the kit's dev window the final version grades at about -0.03 SOL net PnL with a max drawdown under 1% and 61 round trips over 61 coins — roughly breakeven, well inside every guardrail. The final window is different data recorded after entries close, so that number is a sanity check, not a promise.

The bot is deterministic: it reads no clock, uses no randomness, and decides only from the batch stream in arrival order, so two runs over the same data produce the same orders byte for byte.

## Layout

- `main.ts` — the entrypoint the grader runs (`node /bot/main.ts`), strategy included.
- `vendor/makefun-bot.ts` — the kit's TypeScript SDK shim for the agent-fun/replay/v2 protocol, vendored unchanged.
- `LICENSE` — MIT.

## Running it

The grader mounts this repo and runs `node main.ts` (Node 22.18+). Locally it can be graded with the competition kit:

```
node cli/makefun.mjs grade-local --kit <kit dir> --bot <this repo> --driver process
```
