# El Oraculo Architecture

Autonomous AI enhancement engine for crypto grid trading bots. El Oraculo sits alongside your trading bot as a separate process, observes market data and bot performance, generates parameter-tuning signals, resolves conflicts between signal sources, gates signals through a confidence system, and applies approved changes via a relay server. It never touches your bot's core logic, positions, or risk guards directly.

```
                        EL ORACULO SYSTEM ARCHITECTURE

  ┌──────────────────────────────────────────────────────────────────────┐
  │  El Oraculo (Node.js, port 4203)                                   │
  │                                                                      │
  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐               │
  │  │  Collector   │  │  Optimizer   │  │  Predictor   │               │
  │  │  api-reader  │  │  backtest    │  │  llm [Pro]   │               │
  │  │  db-reader   │  │  patterns    │  │  feeder[Pro] │               │
  │  │              │  │  hmm   [Pro] │  │  personas    │               │
  │  │              │  │  loop  [Pro] │  │  simulation  │               │
  │  │              │  │  scoring     │  │              │               │
  │  │              │  │  param-space │  │              │               │
  │  │              │  │  history     │  │              │               │
  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │
  │         │                 │                  │                       │
  │         ▼                 ▼                  ▼                       │
  │  ┌──────────────────────────────────────────────────────────┐       │
  │  │                    ORCHESTRATOR                          │       │
  │  │  scheduler ─── signal-bus ─── conflict-resolver          │       │
  │  │  confidence-tracker ─── watchdog ─── telegram-sender     │       │
  │  │  dashboard ─── goal-system [Pro]                         │       │
  │  └────────────────────────┬─────────────────────────────────┘       │
  │                           │                                         │
  │  ┌────────────────────────┘                                        │
  │  │  Evolution [Pro]                                                 │
  │  │  skill-tracker                                                   │
  │  └─────────────────                                                │
  └──────────────────────────┬───────────────────────────────────────────┘
                             │ HTTP POST /api/apply-signal
                             ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  Relay Server (port 4202)                                           │
  │  ├── Binance Proxy (read-only, signed with bot's API keys)          │
  │  ├── Signal Applicator (forwards param changes to bot)              │
  │  └── Killswitch (revert last 3 signals, pause 12h)                  │
  └──────────────────────────┬───────────────────────────────────────────┘
                             │ HTTP POST /api/apply-param
                             ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  Your Trading Bot (port 4201)                                       │
  │  ├── REST API: /api/status, /api/indicators, /api/apply-param       │
  │  ├── Trading Database (SQLite, read-only access by Oraculo)         │
  │  └── Grid Engine (positions, orders, risk guards)                   │
  └──────────────────────────────────────────────────────────────────────┘
```

---

## 1. System Overview

El Oraculo is a standalone Node.js process that enhances a grid trading bot without modifying it. The bot runs independently with its own risk guards, position management, and order execution. Oraculo observes the bot's state, analyzes market data, and produces **signals** -- structured JSON objects recommending parameter changes like grid spacing or allocation adjustments.

Key design principles:

- **Non-invasive**: Oraculo can only change a whitelisted set of parameters (`spacing`, `allocation`, `atr_mult`). It cannot modify leverage, risk guards, or open positions.
- **Graceful degradation**: If Oraculo crashes, the bot continues operating on its last-known parameters. The bot has its own `systemd Restart=always`.
- **Monitor-only watchdog**: The watchdog sends Telegram alerts but never restarts or kills the bot.
- **Separation of concerns**: The relay server runs on the same machine as the bot and handles Binance API signing. Oraculo itself never holds API secrets.

---

## 2. Module Map

### `src/config.ts`
Central configuration loaded from environment variables via zod validation. Defines all schedule intervals, confidence thresholds, safety bounds, autoresearch limits, and file paths.

### `src/types.ts`
TypeScript interfaces for every data structure: `Signal`, `ParamChangePayload`, `RegimePredictionPayload`, `SpacingSuggestionPayload`, `ElPesosStatus`, `PositionInfo`, `RiskGuardStatus`, `BinanceIncome`, `BinanceBalance`, `PerformanceSnapshot`, `DailyPnl`, `WeeklyGoal`, `Indicators`, `WatchdogState`.

### `src/index.ts`
Entry point. Starts the dashboard, attempts to load Pro modules dynamically via `require()` (failures silently degrade to free tier), starts the scheduler, registers graceful shutdown handlers for SIGINT/SIGTERM.

### Collector (`src/collector/`)

| File | Purpose |
|------|---------|
| `api-reader.ts` | HTTP client for 15+ trading bot REST endpoints and 3 Binance proxy endpoints. All requests use `AbortController` with 5s timeout. |
| `db-reader.ts` | Read-only SQLite queries against the trading bot's database (`better-sqlite3`). Reads performance snapshots, learning changes, trades, grid sessions, daily PnL, playbook patterns, news impacts, equity snapshots, and state values. |

### Optimizer (`src/optimizer/`)

| File | Purpose |
|------|---------|
| `backtest-engine.ts` | Grid trading simulator faithful to real bot mechanics. Includes ADX guard (4-tier), fee profitability guard, drawdown halt, anti-tilt cooldowns, position abandonment on reposition. |
| `param-space.ts` | Defines all tunable parameters with min/max bounds and step sizes. Provides `clampParams()`, `paramDistance()`, and `maxChangePct()` utilities. |
| `pattern-analyzer.ts` | 30-day deep analysis: volatility regime detection, time-of-day profiles, mean reversion characteristics, drawdown event detection, rolling weekly backtests. |
| `history-loader.ts` | Fetches 1-minute candles from Binance public futures API (`/fapi/v1/klines`). Caches to `./backtest-data/` with daily rotation, auto-cleans files older than 7 days. |
| `scoring.ts` | Scoring function aligned with the real trading bot's learning engine: `0.6 * fillRate + 0.4 * pnlPerTrip`. |
| `hmm-filter.ts` | **[Pro]** Forward algorithm for HMM state probability computation at each timestep. |
| `hmm-trainer.py` | **[Pro]** Python script that trains a 2-state GaussianHMM on 30-day hourly log-returns using `hmmlearn`. Sorts states by variance, validates transition matrix. |
| `hmm-signal-generator.ts` | **[Pro]** Generates spacing signals from HMM regime state. Only fires when confidence exceeds 70%. |
| `loop-runner.ts` | **[Pro]** Karpathy autoresearch loop: propose parameter mutation, backtest, compare to baseline, keep if improvement > 2%, revert otherwise. 20 iterations per 12h cycle. |
| `compare-regimes.ts` | **[Pro]** Backtests ADX-threshold regime detection vs HMM-based detection side-by-side. |

### Orchestrator (`src/orchestrator/`)

| File | Purpose |
|------|---------|
| `scheduler.ts` | Central scheduler running all modules on their intervals. Dynamically loads Pro modules. Processes signals every 60s. |
| `signal-bus.ts` | File-based signal queue in `./signals/`. Creates signal JSON files with UUID filenames, reads pending signals sorted by confidence, handles TTL expiry and cleanup. |
| `conflict-resolver.ts` | Groups signals by target (type + symbol + parameter). Detects directional conflicts (increase vs decrease). Winner = highest confidence, penalized 20%. |
| `confidence-tracker.ts` | Confidence multiplier that compounds on outcomes. Persisted to `./confidence-state.json`. |
| `dashboard.ts` | Express server on port 4203. Serves REST API endpoints and an inline HTML command center UI with auto-refresh. |
| `watchdog.ts` | Health check every 30s via `/api/status`. Monitor-only: alerts at 5, 20, and every 10 subsequent failures. Never restarts or kills the bot. |
| `telegram-sender.ts` | Sends notifications via Telegram Bot API. Includes signal notification formatter and daily report template. |
| `goal-system.ts` | **[Pro]** Self-evolving weekly revenue targets sourced from Binance income API. Compounds target upward 10% on success, diagnoses on failure. |

### Predictor (`src/predictor/`)

| File | Purpose |
|------|---------|
| `llm-predictor.ts` | **[Pro]** Nemotron 120B via OpenRouter. Structured market predictions with calibrated confidence. |
| `market-feeder.ts` | **[Pro]** Aggregates RSI, MACD, ADX, Hurst, BB squeeze, funding rates, and news sentiment into LLM context. |
| `persona-bank.ts` | **[Pro]** Multi-persona prediction framework. |
| `predictor.ts` | **[Pro]** Core prediction orchestrator. |
| `simulation-runner.ts` | **[Pro]** Monte Carlo simulation runner for prediction validation. |

### Evolution (`src/evolution/`)

| File | Purpose |
|------|---------|
| `skill-tracker.ts` | **[Pro]** Revenue attribution per signal source. Tracks which modules generate money. Promotes profitable strategies, deprecates underperformers. |

### Relay (`src/relay/`)

| File | Purpose |
|------|---------|
| `server.ts` | Self-contained Express server on port 4202. Binance API proxy (read-only, HMAC-SHA256 signed), signal applicator (forwards to bot), and killswitch. |

---

## 3. Data Flow

```
Market Data (Binance 1m candles, public API)
     │
     ▼
┌──────────────────┐
│  history-loader   │ ── fetches & caches to ./backtest-data/
└────────┬─────────┘
         │
         ├──────────────────────┬──────────────────────────┐
         ▼                      ▼                          ▼
┌─────────────────┐  ┌──────────────────┐   ┌──────────────────────┐
│  backtest-engine │  │ pattern-analyzer │   │ hmm-trainer.py [Pro] │
│  (grid sim)      │  │ (30d analysis)   │   │ (GaussianHMM)        │
└────────┬────────┘  └────────┬─────────┘   └──────────┬───────────┘
         │                     │                        │
         ▼                     ▼                        ▼
┌──────────────────────────────────────────────────────────────┐
│  Signal Generators                                           │
│  loop-runner [Pro] │ hmm-signal-generator [Pro] │ llm [Pro]  │
└────────────────────────────────┬─────────────────────────────┘
                                 │ createSignal()
                                 ▼
                    ┌──────────────────────┐
                    │  signal-bus (./signals/) │
                    │  JSON files with UUID │
                    └───────────┬──────────┘
                                │ readPendingSignals()
                                ▼
                    ┌──────────────────────┐
                    │  conflict-resolver    │ ── groups by target, resolves direction conflicts
                    └───────────┬──────────┘
                                │
                                ▼
                    ┌──────────────────────┐
                    │  confidence gate      │ ── multiplier * confidence → action tier
                    └───────────┬──────────┘
                                │
                    ┌───────────┴──────────────────────┐
                    │ < 0.40 → log only                 │
                    │ 0.40-0.60 → apply at 50% strength │
                    │ 0.60-0.80 → apply at 100%         │
                    │ > 0.80 → apply + widen exploration │
                    └───────────┬──────────────────────┘
                                │ HTTP POST
                                ▼
                    ┌──────────────────────┐
                    │  relay server (:4202) │ ── forwards to bot
                    └───────────┬──────────┘
                                │ HTTP POST /api/apply-param
                                ▼
                    ┌──────────────────────┐
                    │  trading bot (:4201)  │ ── validates bounds, applies param
                    └──────────────────────┘
```

---

## 4. Signal Pipeline

### Signal Creation

Signals are JSON objects written to `./signals/` as individual files. Each signal contains:

```typescript
interface Signal {
  id: string                    // UUID
  timestamp: number             // creation time (ms)
  ttlHours: number              // time-to-live before auto-expiry
  source: 'autoresearch' | 'mirofish' | 'sentiment' | 'manual'
  confidence: number            // raw confidence [0, 1]
  adjustedConfidence: number    // confidence * multiplier (capped at 1.5)
  type: 'param_change' | 'regime_prediction' | 'spacing_suggestion' | 'allocation_change'
  payload: ParamChangePayload | RegimePredictionPayload | SpacingSuggestionPayload
  reasoning: string             // human-readable explanation
  status: 'pending' | 'applied' | 'expired' | 'reverted'
}
```

Signals are created by `signal-bus.ts:createSignal()`, which assigns a UUID, stamps the current time, applies the confidence multiplier, and writes the file to disk.

### Conflict Resolution

`conflict-resolver.ts` groups pending signals by target key: `{type}:{symbol}:{parameter}`. Within each group:

1. If only one signal targets a parameter, it passes through unmodified.
2. If multiple signals agree on direction (all increase or all decrease), they all pass through.
3. If signals **conflict** (one says increase, another says decrease), the **highest adjusted confidence wins**, but its confidence is reduced by **20%** as a penalty for disagreement.

### Confidence Gating

After conflict resolution, the scheduler applies the effective confidence to determine the action tier:

| Effective Confidence | Action |
|---------------------|--------|
| < 0.40 | Log only, do not apply |
| 0.40 -- 0.60 | Apply at 50% strength (conservative) |
| 0.60 -- 0.80 | Apply at 100% strength |
| > 0.80 | Apply at 100% + widen exploration range |

### Signal Application

The scheduler sends approved signals to the relay via `POST /api/apply-signal`. The relay forwards to the bot's `POST /api/apply-param` endpoint. On success, the signal file's status is updated to `applied` with an `appliedAt` timestamp.

Parameter names are mapped before sending: `baseSpacingPct` becomes `spacing`, `atrSpacingMult` becomes `atr_mult`, allocation params become `allocation`.

---

## 5. Confidence System

The confidence multiplier is a persistent value stored in `./confidence-state.json` that amplifies or dampens all signal confidence scores.

### Multiplier Mechanics

| Parameter | Value |
|-----------|-------|
| Base | 1.0x |
| Maximum | 1.5x |
| Minimum | 0.5x |
| Win increment | +0.05 per win |
| Loss decrement | -0.10 per miss |

### Compounding

- Each **win** (applied signal that produced positive PnL) increases the multiplier by 0.05, up to 1.5x.
- Each **miss** (applied signal that produced negative PnL) decreases the multiplier by 0.10, down to 0.5x.
- Losses are penalized 2x harder than wins are rewarded, creating a conservative bias.

### Pause Mechanics

After **3 consecutive misses**:
1. Multiplier resets to 1.0x (base).
2. System **pauses for 6 hours** -- no signals are processed during this period.
3. Consecutive miss counter resets to 0.

During a pause, `isPaused()` returns `true` and the scheduler's `processSignals()` exits immediately.

### State Persistence

The confidence state includes a history of the last 100 outcomes with before/after multiplier values, enabling trend analysis from the dashboard.

---

## 6. Backtest Engine

`src/optimizer/backtest-engine.ts` -- 515 lines, faithful simulation of the real grid trading bot.

### Grid Placement

The engine places 4 grid orders around a center price: 2 buy levels below and 2 sell levels above (adjusted to 3/1 in directional ADX tier). Order quantity is calculated as `(allocation * leverage) / (totalLevels * centerPrice)`.

### ADX Guard (4-Tier)

Computed every hour from aggregated hourly candles using Wilder's ADX method (period 14):

| Tier | ADX Range | Behavior |
|------|-----------|----------|
| `neutral` | < `adxNeutral` (default 20) | Normal grid, base spacing |
| `bias` | `adxNeutral` -- `adxBias` (20-30) | Spacing multiplied by `biasSpacingMult` (1.3x) |
| `directional` | `adxBias` -- `adxDirectional` (30-40) | Spacing multiplied by `directionalSpacingMult` (1.5x), 3:1 buy/sell bias |
| `pause` | > `adxDirectional` (40+) | No grid orders, wait for trend to weaken |

Tier transitions use **hysteresis** (5-point buffer on de-escalation) to prevent whipsaw.

### Risk Guards

- **Killswitch**: If unrealized PnL drops below -$50, halt trading for 30 minutes.
- **Soft halt**: If drawdown exceeds 10% from session high, halt for 30 minutes.
- **Hard halt**: If drawdown exceeds 20%, halt for 4 hours.
- **Anti-tilt cooldowns**: 3-tier system based on consecutive losses:

| Consecutive Losses | Cooldown |
|-------------------|----------|
| 5 | 5 minutes |
| 8 | 10 minutes |
| 12 | 20 minutes |

### Fee Profitability Guard

If `baseSpacingPct` is less than `MAKER_FEE * 2 * 3 = 0.12%`, the engine forces spacing to the minimum profitable level. This prevents the grid from placing orders where round-trip fees would consume the profit.

### Position Abandonment

When price drifts beyond `repositionPct` (default 1.5%) from center, or when ADX tier changes, the grid repositions. All open positions are closed at market price (taker fee 0.05%) and counted as losses. This models the real-world cost of repositioning.

### Scoring

```
compositeScore = 0.6 * normalizedFillRate + 0.4 * normalizedPnlPerTrip
```

- `fillRate` = total fills / total hours, capped at 10/hr for normalization.
- `pnlPerTrip` = total PnL / total round-trips, capped at $1.00 for normalization.

This scoring is identical to the real bot's learning engine -- it rewards grid efficiency (fills) more than raw profit, preventing overfitting to lucky trades.

---

## 7. Pattern Analyzer

`src/optimizer/pattern-analyzer.ts` performs deep analysis on 30 days of candle data, producing `PatternInsights` with five analysis dimensions.

### Volatility Regime Detection

Aggregates 1m candles to hourly, computes 14-period ATR as a percentage of price. Classifies each hour into quartile-based regimes:

| Regime | ATR Percentile | Meaning |
|--------|---------------|---------|
| `low` | 0-25th | Calm, tight grid spacing optimal |
| `medium` | 25-75th | Normal conditions |
| `high` | 75-95th | Elevated volatility, widen spacing |
| `extreme` | 95th+ | Event-driven, consider pausing |

Consecutive hours in the same regime are grouped into regime periods with duration and average ATR.

### Time-of-Day Profiles

For each UTC hour (0-23), computes:
- Average volatility (candle body as % of close)
- Average range (high-low as % of close)
- Average volume
- Optimal spacing (range * 0.4, clamped to 0.25%-0.60%)

### Mean Reversion Characteristics

Per-pair analysis measuring:
- **Bounce from low**: When price breaks below prior candle low, how much does it recover? (Higher = more mean-reverting)
- **Bounce from high**: When price breaks above prior candle high, how much does it retrace?
- **Wick ratio**: Total wick length / total candle range. Above 60% = strong mean reversion, grid-favorable.
- **Trendiness**: Net price movement / total absolute movement. 0 = pure range-bound, 1 = pure trend.

### Drawdown Detection

Tracks price peaks and troughs. Any drawdown exceeding 2% is recorded with start time, depth, recovery duration, and cause classification (`major_move` for >5%, `normal_volatility` otherwise). Top 20 drawdowns are returned sorted by depth.

### Rolling Weekly Backtests

Runs the backtest engine on each 7-day window within the data, producing a score per week. This reveals consistency: a system with stable weekly scores is more robust than one with high variance.

---

## 8. HMM Markov Model [Pro]

The Hidden Markov Model provides probabilistic regime detection that outperforms threshold-based ADX guards.

### Architecture

A 2-state GaussianHMM where each hidden state represents a market regime:

- **State 0 (Normal)**: Low-variance returns. Market is range-bound. Grid runs tight spacing.
- **State 1 (Spike)**: High-variance returns. Trending or volatile event. Grid widens spacing or pauses.

### Training (`hmm-trainer.py`)

1. Fetches 30 days of hourly candles from Binance.
2. Computes log-returns: `ln(close_t / close_{t-1})`.
3. Fits a 2-state GaussianHMM using the EM algorithm (`hmmlearn`).
4. Sorts states by variance so State 0 is always "normal" (lower variance).
5. Validates transition matrix: normal-to-normal probability should be >90%.
6. Saves model parameters to disk.

Typical learned transition matrix:

```
         Normal -> Normal:  96.8%    Normal -> Spike:  3.2%
         Spike  -> Normal:  89.8%    Spike  -> Spike: 10.2%
```

### Forward Filter (`hmm-filter.ts`)

At each hour, the forward algorithm computes `P(state | all observations so far)`. This is more robust than looking at a single indicator value because it considers the entire observation history.

Signals are only generated when state probability exceeds 70%, preventing false regime transitions.

### Signal Generation (`hmm-signal-generator.ts`)

When the HMM detects a regime change with sufficient confidence:
- Normal to Spike: Widens spacing, reduces allocation.
- Spike to Normal: Tightens spacing, increases allocation.

### Measured Improvements

| Metric | ADX Thresholds | HMM | Delta |
|--------|---------------|-----|-------|
| Win rate (SOL) | 77.9% | 87.0% | +9.1% |
| Win rate (TAO) | 85.9% | 91.4% | +5.5% |
| Abandoned positions (TAO) | 62 | 44 | -29% |
| Regime changes (TAO) | 62 | 0 | -100% |

The `compare-regimes.ts` module backtests both approaches side-by-side to validate these gains on current data.

---

## 9. LLM Predictor [Pro]

### Model

Nvidia Nemotron 120B (free via OpenRouter at `nvidia/nemotron-3-super-120b-a12b:free`). Daily spend capped at `OPENROUTER_DAILY_CAP` (default $5).

### Market Feeder (`market-feeder.ts`)

Aggregates the following into a structured LLM context:
- RSI, MACD histogram, ADX per pair
- Hurst exponent (mean reversion vs trend strength)
- Bollinger Band squeeze and direction
- Funding rates and bias
- Permutation entropy
- News sentiment and impact scores

### Prediction Cycle

Runs every 4 hours (`mirofishIntervalMs`):

1. Market feeder collects current indicators from the bot and relay.
2. LLM predictor constructs a structured prompt with all indicator data.
3. Nemotron returns structured JSON predictions with calibrated confidence.
4. Predictions are converted to signals via `createSignal()` with source `mirofish`.

### Multi-Persona Framework

`persona-bank.ts` and `simulation-runner.ts` support a multi-persona prediction approach where different "analyst personas" can provide contrasting predictions that are then synthesized.

---

## 10. Autoresearch (Karpathy Loop) [Pro]

Adapted from [Karpathy's autoresearch](https://github.com/karpathy/autoresearch). The `loop-runner.ts` autonomously optimizes parameters through iterative experimentation.

### Cycle Structure

Each cycle runs every 12 hours with up to 20 iterations:

```
┌──────────────────────────────────────────────────┐
│  AUTORESEARCH CYCLE                               │
│                                                    │
│  1. Load baseline: current params + their score    │
│  2. For iteration 1..20:                           │
│     a. Propose mutation (pattern-guided)           │
│     b. Clamp to parameter bounds                   │
│     c. Reject if max change > 10%                  │
│     d. Backtest on 7-day candle data               │
│        - Walk-forward split: 5-day train, 2-day    │
│     e. Score: 0.6*fillRate + 0.4*pnlPerTrip        │
│     f. If improvement >= 2%: KEEP, update baseline  │
│     g. If improvement < 2%: DISCARD, revert         │
│  3. Emit signals for all kept changes               │
└──────────────────────────────────────────────────┘
```

### Pattern-Guided Proposals

The pattern analyzer's insights inform mutation direction. For example:
- If volatility regimes are predominantly "high", propose wider spacing.
- If mean reversion wick ratio is >60%, propose tighter spacing.
- If a particular time-of-day shows low fill rates, adjust allocation.

### Walk-Forward Validation

Backtests use a 5-day training window and 2-day validation window (`walkForwardSplit: [5, 2]`). The candidate must improve on the validation window, not just the training window, preventing overfitting.

### Guardrails

- Maximum 10% change per parameter per iteration (`maxParamChangePct`).
- Minimum 2% improvement required to keep (`minImprovementPct`).
- All parameters clamped to defined bounds (see Parameter Space below).

---

## 11. Goal System [Pro]

`src/orchestrator/goal-system.ts` implements self-evolving weekly revenue targets.

### Mechanics

1. **Initialization**: Fetches the past 2 weeks of income from Binance (`/fapi/v1/income`) to establish a baseline weekly target.
2. **Weekly evaluation**: Every Sunday at 00:00 UTC, compares actual income to target.
3. **Success (target met)**: New target = previous target * 1.10 (compound 10% upward).
4. **Failure (target missed)**: Diagnoses underperformance (which pairs underperformed, which modules contributed least), recalibrates target downward.
5. **Attribution**: Tracks which signal source (`topModule`) contributed most revenue.

### WeeklyGoal Structure

```typescript
interface WeeklyGoal {
  weekStart: string           // ISO date
  target: number              // USD target
  actual: number              // USD actual income
  achieved: boolean
  multiplierAtWeekEnd: number // confidence multiplier at week close
  topModule: string           // best-performing signal source
  topModuleRevenue: number    // revenue from top module
}
```

---

## 12. Relay Server

`src/relay/server.ts` -- self-contained Express server on port 4202 deployed on the same machine as the trading bot.

### Binance Proxy (Read-Only)

Loads the bot's Binance API credentials from its `.env` file (`EL_PESOS_ENV_PATH`, default `/opt/crypto-bot/.env`). Signs all requests with HMAC-SHA256. Exposes:

- `GET /api/binance/balance` -- wallet balance, available balance, unrealized profit
- `GET /api/binance/income` -- income history with optional `startTime`, `endTime`, `incomeType` filters
- `GET /api/binance/positions` -- active positions (non-zero `positionAmt`)

All requests use a 15-second timeout via `AbortController`.

### Signal Applicator

- `POST /api/apply-signal` -- Receives signal from Oraculo, forwards to bot's `POST /api/apply-param`. Passes `parameter`, `symbol`, `newValue`, `source`, `signalId`, and `strength`.

### Killswitch

- `POST /api/kill` -- Emergency stop. Reverts the last 3 applied signals (marks them `reverted`), pauses Oraculo for 12 hours.

### Signal Reader

- `GET /api/signals/pending` -- Lists pending signal files with TTL filtering.

---

## 13. Safety Guards

### Parameter Whitelist

Only three parameters can be modified by Oraculo:

| Parameter | Mapped Name | Bounds |
|-----------|------------|--------|
| `baseSpacingPct` | `spacing` | 0.25% -- 0.60% |
| `atrSpacingMult` | `atr_mult` | 0.15 -- 0.50 |
| `ethAllocation` / `solAllocation` / `taoAllocation` | `allocation` | $15 -- $80 (varies by pair) |

Oraculo **cannot** change: leverage, risk guard thresholds, trading pairs, position sizes directly, or any order-level parameter.

### Bounds Checking

`param-space.ts:clampParams()` enforces min/max bounds and rounds to defined step sizes. The `PARAM_BOUNDS` table:

| Parameter | Min | Max | Step |
|-----------|-----|-----|------|
| `baseSpacingPct` | 0.0025 | 0.0060 | 0.0005 |
| `atrSpacingMult` | 0.15 | 0.50 | 0.05 |
| `adxNeutral` | 15 | 25 | 1 |
| `adxBias` | 25 | 35 | 1 |
| `adxDirectional` | 35 | 50 | 2 |
| `biasSpacingMult` | 1.1 | 1.6 | 0.1 |
| `directionalSpacingMult` | 1.2 | 2.0 | 0.1 |
| `repositionPct` | 0.010 | 0.025 | 0.002 |
| `ethAllocation` | 40 | 70 | 5 |
| `solAllocation` | 25 | 50 | 5 |
| `taoAllocation` | 30 | 55 | 5 |

### Rate Limiting

The scheduler processes signals every 60 seconds. The autoresearch loop enforces `maxParamChangePct: 0.10` (10% max change per iteration). At the bot level, the bot's own `POST /api/apply-param` endpoint enforces per-parameter rate limits (1 change per 5 minutes).

### Max Change Per Application

`param-space.ts:maxChangePct()` computes the largest percentage change between original and modified params. The autoresearch loop rejects any candidate where any single parameter changes more than 10%.

### Auto-Revert

If PnL drops more than 15% (`autoRevertPnlDropPct`) within 24 hours (`autoRevertWindowHours`) after signal application, the system can revert up to the last 3 signals (`maxRevertHistory`). The killswitch pauses for 12 hours (`killPauseHours`).

### Watchdog (Monitor-Only)

`src/orchestrator/watchdog.ts` runs a health check every 30 seconds:

1. Calls `GET /api/status` on the trading bot (2s timeout).
2. On success: resets fail counter; if recovering from 5+ fails, sends recovery alert.
3. On failure: increments counter.
   - At 5 fails (2.5 min): "unresponsive" alert.
   - At 20 fails (10 min): "down, check manually" alert.
   - After 20: alerts every 5 minutes.

The watchdog **never** restarts the bot, kills positions, or takes any corrective action. The user holds the killswitch.

---

## 14. Dashboard

### UI

The dashboard at `http://localhost:4203` is a single-page command center served as inline HTML from `dashboard.ts`. It auto-refreshes every 5 seconds by polling all API endpoints.

Dashboard sections:
- **System Status**: Online/offline indicator, uptime, watchdog health, pending signal count.
- **Confidence Multiplier**: Current multiplier with progress bar (0.5x-1.5x range), win/miss streaks, pause status.
- **Weekly Goal** [Pro]: Current week's actual vs target with progress bar and percentage.
- **Autoresearch** [Pro]: Current iteration, kept/discarded counts, baseline score.
- **Skill Evolution** [Pro]: Active/promoted/deprecated skill counts, total revenue.
- **Recent Signals**: Table of last 15 signals with time, source, type, confidence, status, and reasoning.
- **Autoresearch Experiments** [Pro]: Table of last 10 experiments with iteration, parameter, change, score, and keep/discard status.

---

## 15. Configuration Reference

All configuration via environment variables, validated by zod in `src/config.ts`.

### Required

| Variable | Description |
|----------|-------------|
| `EL_PESOS_API` | Trading bot REST API URL (default `http://localhost:4201`) |
| `RELAY_API` | Relay server URL (default `http://localhost:4202`) |

### Optional -- Core

| Variable | Default | Description |
|----------|---------|-------------|
| `ORACULO_PORT` | `4203` | Dashboard HTTP port |
| `TELEGRAM_BOT_TOKEN` | -- | Telegram bot token for alerts |
| `TELEGRAM_CHAT_ID` | -- | Telegram chat ID for alerts |

### Optional -- AI [Pro]

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | -- | OpenRouter API key for LLM predictions |
| `OPENROUTER_DAILY_CAP` | `5` | Daily spend cap in USD |
| `OLLAMA_URL` | `http://localhost:11434` | Local Ollama instance URL |
| `PGVECTOR_URL` | `postgresql://user:password@localhost:5432/oraculo` | PostgreSQL with pgvector for embeddings |

### Internal Constants (in `config.ts`)

| Constant | Value | Description |
|----------|-------|-------------|
| `schedules.watchdogIntervalMs` | 30,000 | Watchdog poll interval |
| `schedules.collectorIntervalMs` | 300,000 | Data collection interval (5 min) |
| `schedules.autoresearchIntervalMs` | 43,200,000 | Autoresearch cycle interval (12h) |
| `schedules.mirofishIntervalMs` | 14,400,000 | LLM prediction interval (4h) |
| `schedules.goalEvalDay` | 0 (Sunday) | Weekly goal evaluation day |
| `autoresearch.maxIterationsPerCycle` | 20 | Max experiments per cycle |
| `autoresearch.minImprovementPct` | 0.02 | 2% minimum improvement to keep |
| `autoresearch.maxParamChangePct` | 0.10 | 10% max change per parameter |
| `autoresearch.backtestDays` | 7 | Days of candle data for backtest |
| `autoresearch.walkForwardSplit` | [5, 2] | Train/validation day split |
| `confidence.baseMultiplier` | 1.0 | Starting confidence multiplier |
| `confidence.maxMultiplier` | 1.5 | Ceiling |
| `confidence.minMultiplier` | 0.5 | Floor |
| `confidence.winIncrement` | 0.05 | Multiplier bump per win |
| `confidence.lossDecrement` | 0.10 | Multiplier drop per miss |
| `confidence.consecutiveMissReset` | 3 | Misses before pause |
| `confidence.pauseHoursOnReset` | 6 | Hours paused after reset |
| `safety.autoRevertPnlDropPct` | 0.15 | PnL drop threshold for auto-revert |
| `safety.autoRevertWindowHours` | 24 | Window for measuring PnL drop |
| `safety.maxRevertHistory` | 3 | Max signals to revert |
| `safety.killPauseHours` | 12 | Pause duration after killswitch |

---

## 16. Deployment

### Architecture

El Oraculo runs as two separate processes:

1. **Main engine** (port 4203) -- runs the orchestrator, optimizer, predictor, and dashboard. Can run on any machine with network access to the bot and relay.
2. **Relay server** (port 4202) -- runs on the same machine as the trading bot. Needs access to the bot's Binance API credentials and its REST API.

### systemd Services

**Oraculo main engine** (`oraculo.service`):
```ini
[Unit]
Description=El Oraculo Enhancement Engine
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/el-oraculo
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
EnvironmentFile=/opt/el-oraculo/.env

[Install]
WantedBy=multi-user.target
```

**Oraculo relay** (`oraculo-relay.service`):
```ini
[Unit]
Description=El Oraculo Relay Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/el-oraculo
ExecStart=/usr/bin/node dist/relay/server.js
Restart=always
RestartSec=10
EnvironmentFile=/opt/el-oraculo/.env

[Install]
WantedBy=multi-user.target
```

### Build

```bash
npm install
npm run build          # TypeScript -> dist/
npm run train:hmm      # Train HMM models (Pro, requires Python 3.10+)
```

### Ports

| Port | Service | Purpose |
|------|---------|---------|
| 4201 | Trading bot | Bot REST API (not part of Oraculo) |
| 4202 | Oraculo relay | Binance proxy + signal applicator |
| 4203 | Oraculo main | Dashboard + orchestrator API |

### Data Directories

| Path | Purpose | Persistence |
|------|---------|-------------|
| `./signals/` | Signal JSON files (pending, applied, reverted) | Ephemeral, auto-cleaned |
| `./backtest-data/` | Cached Binance candle data | Auto-cleaned after 7 days |
| `./reports/` | Generated analysis reports | Persistent |
| `./confidence-state.json` | Confidence multiplier state | Persistent, critical |
| `./autoresearch-state.json` | Autoresearch loop state [Pro] | Persistent |
| `./autoresearch-results.tsv` | Experiment log [Pro] | Persistent, append-only |
| `/shared/trading-db/trading.db` | Trading bot SQLite database (read-only) | External, managed by bot |

---

## 17. API Reference

### Oraculo Dashboard (`:4203`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Dashboard HTML UI (command center) |
| `GET` | `/api/status` | Scheduler state: running, multiplier, paused, pending signals, Pro module status |
| `GET` | `/api/confidence` | Full confidence state: multiplier, win/miss streaks, pause status, last 100 outcomes |
| `GET` | `/api/goals` | Current weekly goal + goal history [Pro] |
| `GET` | `/api/signals?limit=N` | Signal history (default last 50) |
| `GET` | `/api/signals/pending` | Currently pending (unapplied) signals |
| `GET` | `/api/watchdog` | Watchdog state: consecutive fails, last success/fail timestamps |
| `GET` | `/api/evolution` | Skill evolution report: active/promoted/deprecated skills, total revenue [Pro] |
| `GET` | `/api/autoresearch` | Autoresearch state + experiment results [Pro] |
| `GET` | `/api/health` | Health check: `{status, uptime, timestamp}` |

### Relay Server (`:4202`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/binance/balance` | Binance futures account balance (wallet, available, unrealized) |
| `GET` | `/api/binance/income?startTime=&endTime=&incomeType=&limit=` | Binance income history (realized PnL, commissions, funding) |
| `GET` | `/api/binance/positions` | Active Binance futures positions (non-zero amount) |
| `POST` | `/api/apply-signal` | Apply a parameter change signal to the trading bot. Body: `{parameter, symbol?, newValue, source, signalId, strength}` |
| `GET` | `/api/signals/pending` | Read pending signal files from `./signals/` |
| `POST` | `/api/kill` | Emergency killswitch: reverts last 3 applied signals, pauses 12h |
| `GET` | `/api/health` | Relay health check: `{status, uptime, timestamp, signalsDir}` |

### Trading Bot API (`:4201`, not part of Oraculo)

These are the endpoints Oraculo expects the trading bot to expose:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | Bot state: balance, positions, risk guards, regime, funding, learning |
| `GET` | `/api/indicators` | Per-pair indicators: RSI, MACD, ADX, Hurst, BB squeeze, supertrend |
| `GET` | `/api/daily-pnl?days=N` | Daily PnL breakdown |
| `GET` | `/api/snapshots/:symbol?hours=N` | Performance snapshots per pair |
| `GET` | `/api/binance-stats` | Binance account stats |
| `GET` | `/api/regime/:symbol` | Current regime state per pair |
| `GET` | `/api/funding` | Funding rate data |
| `GET` | `/api/risk` | Risk guard status |
| `GET` | `/api/news-events?hours=N` | Recent news events |
| `GET` | `/api/news-impact?hours=N` | News with measured price impact |
| `GET` | `/api/equity-history?days=N` | Equity curve history |
| `GET` | `/api/learning` | Learning engine status |
| `GET` | `/api/goals` | Goal system status |
| `GET` | `/api/whale-alerts` | Recent whale alerts |
| `POST` | `/api/apply-param` | Apply parameter override. Body: `{parameter, symbol, newValue, source, signalId}` |

---

## Schedule Summary

```
Every 30s  ─── Watchdog health check
Every 60s  ─── Signal processor (read pending, resolve, gate, apply)
Every 10m  ─── Expired signal cleanup
Every 1h   ─── HMM regime signal generation [Pro]
Every 4h   ─── LLM prediction cycle [Pro]
Every 12h  ─── Autoresearch optimization cycle [Pro]
Weekly     ─── HMM model retraining (Sunday 02:00 UTC) [Pro]
Weekly     ─── Goal evaluation (Sunday 00:00 UTC) [Pro]
```
