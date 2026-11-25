# pump-bot

![Competition](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)
![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/qazzk13/makefun-pumpbot/rank.svg)
![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/qazzk13/makefun-pumpbot/reward.svg)

Entry for [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on make.fun. It is a paper-trading bot: the harness replays recorded pump.fun chain data at it, and it answers each batch with buy or sell orders. No real money, no keys, no network.

## How it trades, in plain words

I did not want a bot that buys everything and prays, so this one waits for the tape to show actual buying. For every coin it keeps the last ~90 slots of trades. A coin only gets bought when, inside that window, there were at least 8 trades from at least 4 different buyers, at least 62% of the traded SOL came in on the buy side, and the price is up between 2% and 80% over the window. Past 80% I figure the move already happened and I would just be someone's exit liquidity.

Stakes are 0.08 SOL per position, capped by whatever the curve's reserve size allows, and never more than 5 positions at once out of the 10 SOL paper bankroll. Exits are mechanical: sell everything at -16% (stop loss), at +30% (take profit), on a trailing stop once a position has been up 18% and falls 12% off its peak, or after 900 slots if nothing happened. Whichever comes first.

The contest also wants at least 20 different coins to complete a full round trip with at least 0.01 SOL bought. Momentum signals alone might not get there on a quiet tape, so if round trips are lagging, the bot opens small 0.02 SOL probe positions on liquid, actively traded curves and closes them within 240 slots. Probes are not meant to make money; they are there so the entry clears the guardrails, and they are sized so their fees stay a rounding error.

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
