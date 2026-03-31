/**
 * Regime Detector Comparison: ADX Thresholds vs HMM
 *
 * Runs the same backtest with two different regime detection methods
 * and compares metrics. Uses existing faithful backtest engine for ADX,
 * and an HMM-enhanced variant for Markov.
 */

import { runBacktest, type Candle, type BacktestResult } from './backtest-engine'
import { scoreResult } from './scoring'
import { loadCandles } from './history-loader'
import { loadHMMModel, forwardFilter, type HMMModel, type HMMState } from './hmm-filter'
import { CURRENT_DEFAULTS, type ParamSet } from './param-space'

const PAIRS = ['ETHUSDT', 'SOLUSDT', 'TAOUSDT']
const ALLOCS: Record<string, number> = { ETHUSDT: 55, SOLUSDT: 35, TAOUSDT: 40 }

interface ComparisonResult {
  pair: string
  window: string
  adx: BacktestResult & { regimeChanges: number }
  hmm: BacktestResult & { regimeChanges: number }
  delta: {
    winRate: string
    pnl: string
    abandoned: string
    regimeChanges: string
    fillRate: string
  }
}

/**
 * Run HMM-enhanced backtest.
 * Same grid mechanics as runBacktest, but uses HMM state probabilities
 * instead of ADX thresholds for tier assignment.
 */
function runBacktestHMM(
  candles: Candle[],
  params: ParamSet,
  hmmModel: HMMModel,
  allocation: number,
  leverage = 5,
  confidenceThreshold = 0.65,
): BacktestResult & { regimeChanges: number } {
  if (candles.length < 200) {
    return { ...emptyResult(), regimeChanges: 0 }
  }

  // Pre-compute HMM states from hourly closes
  const hourlyCloses: number[] = []
  let currentHourClose = candles[0].close
  let lastHourTs = Math.floor(candles[0].openTime / 3600000)

  for (const c of candles) {
    const hourTs = Math.floor(c.openTime / 3600000)
    if (hourTs !== lastHourTs) {
      hourlyCloses.push(currentHourClose)
      lastHourTs = hourTs
    }
    currentHourClose = c.close
  }
  hourlyCloses.push(currentHourClose)

  // Compute hourly log returns
  const hourlyReturns: number[] = []
  for (let i = 1; i < hourlyCloses.length; i++) {
    hourlyReturns.push(Math.log(hourlyCloses[i] / hourlyCloses[i - 1]))
  }

  // Run forward filter
  const hmmStates = forwardFilter(hmmModel, hourlyReturns)

  // Map HMM state index to candle index (1 state per hour = 60 candles)
  function getHMMStateForCandle(candleIdx: number): HMMState {
    const hourIdx = Math.floor(candleIdx / 60)
    // Offset by 1 because returns start at hour 1
    const stateIdx = Math.min(Math.max(hourIdx - 1, 0), hmmStates.length - 1)
    return hmmStates[stateIdx]
  }

  // --- Backtest with HMM regime detection ---
  const MAKER_FEE = 0.0002
  const roundTrips: number[] = []
  let equity = allocation
  let sessionHigh = allocation
  let centerPrice = candles[0].close
  let totalFills = 0
  let abandonedPositions = 0
  let regimeChanges = 0
  let currentTier: 'normal' | 'spike' = 'normal'
  let lastTierCheck = 0

  interface GridOrder { price: number; side: 'BUY' | 'SELL'; quantity: number; filledAt?: number }
  interface OpenPos { side: 'LONG' | 'SHORT'; entryPrice: number; quantity: number }

  let gridOrders: GridOrder[] = []
  let openPositions: OpenPos[] = []
  const hourlyPnls: number[] = []
  let hourPnl = 0
  let lastHour = Math.floor(candles[0].openTime / 3600000)

  // Initial grid
  const spacing = getSpacingForTier('normal', params)
  gridOrders = placeGridHMM(centerPrice, spacing, allocation, leverage)

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    const hour = Math.floor(c.openTime / 3600000)

    if (hour !== lastHour) {
      hourlyPnls.push(hourPnl)
      hourPnl = 0
      lastHour = hour
    }

    // HMM regime check (every hour)
    if (c.openTime - lastTierCheck >= 3600000) {
      lastTierCheck = c.openTime
      const hmmState = getHMMStateForCandle(i)

      const newTier: 'normal' | 'spike' = hmmState.state === 1 ? 'spike' : 'normal'

      // Only reposition if tier changes AND confidence exceeds threshold
      if (newTier !== currentTier && hmmState.confidence >= confidenceThreshold) {
        regimeChanges++
        currentTier = newTier

        // Abandon open positions
        if (openPositions.length > 0) {
          const loss = abandonPos(openPositions, c.close)
          if (loss !== 0) {
            roundTrips.push(loss)
            equity += loss
            hourPnl += loss
            if (loss < 0) abandonedPositions++
          }
          openPositions = []
        }

        if (currentTier === 'spike') {
          gridOrders = [] // Pause during spike
        } else {
          centerPrice = c.close
          const sp = getSpacingForTier(currentTier, params)
          gridOrders = placeGridHMM(centerPrice, sp, allocation, leverage)
        }
      }
    }

    // Skip fills during spike (grid paused)
    if (currentTier === 'spike') continue

    // Fill detection
    for (const order of gridOrders) {
      if (order.filledAt !== undefined) continue
      const filled =
        (order.side === 'BUY' && c.low <= order.price) ||
        (order.side === 'SELL' && c.high >= order.price)
      if (filled) {
        order.filledAt = c.openTime
        totalFills++
        openPositions.push({
          side: order.side === 'BUY' ? 'LONG' : 'SHORT',
          entryPrice: order.price,
          quantity: order.quantity,
        })
      }
    }

    // Counter fill detection
    const closed: OpenPos[] = []
    for (const pos of openPositions) {
      const sp = getSpacingForTier(currentTier, params)
      const exitPrice = pos.side === 'LONG'
        ? pos.entryPrice + centerPrice * sp
        : pos.entryPrice - centerPrice * sp

      const exitFilled = (pos.side === 'LONG' && c.high >= exitPrice) ||
        (pos.side === 'SHORT' && c.low <= exitPrice)

      if (exitFilled) {
        const gross = pos.side === 'LONG'
          ? (exitPrice - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - exitPrice) * pos.quantity
        const fees = (pos.entryPrice + exitPrice) * pos.quantity * MAKER_FEE
        const net = gross - fees
        roundTrips.push(net)
        equity += net
        hourPnl += net
        sessionHigh = Math.max(sessionHigh, equity)
        closed.push(pos)
      }
    }
    openPositions = openPositions.filter(p => !closed.includes(p))

    // Reposition on drift
    const drift = Math.abs(c.close - centerPrice) / centerPrice
    if (drift > params.repositionPct) {
      if (openPositions.length > 0) {
        const loss = abandonPos(openPositions, c.close)
        if (loss !== 0) {
          roundTrips.push(loss)
          equity += loss
          hourPnl += loss
          if (loss < 0) abandonedPositions++
        }
        openPositions = []
      }
      centerPrice = c.close
      const sp = getSpacingForTier(currentTier, params)
      gridOrders = placeGridHMM(centerPrice, sp, allocation, leverage)
    }
  }

  // Abandon remaining
  if (openPositions.length > 0) {
    const loss = abandonPos(openPositions, candles[candles.length - 1].close)
    if (loss !== 0) { roundTrips.push(loss); equity += loss; if (loss < 0) abandonedPositions++ }
  }

  const wins = roundTrips.filter(p => p > 0).length
  const losses = roundTrips.filter(p => p <= 0).length
  const totalPnl = roundTrips.reduce((s, p) => s + p, 0)
  const hours = candles.length / 60

  return {
    totalRoundTrips: roundTrips.length,
    wins,
    losses,
    winRate: roundTrips.length > 0 ? wins / roundTrips.length : 0,
    totalPnl,
    avgPnlPerTrip: roundTrips.length > 0 ? totalPnl / roundTrips.length : 0,
    maxDrawdown: sessionHigh > 0 ? (sessionHigh - equity) / sessionHigh : 0,
    sharpeRatio: computeSharpe(hourlyPnls),
    fillRate: hours > 0 ? totalFills / hours : 0,
    compositeScore: 0,
    haltCount: 0,
    tiltPauses: 0,
    abandonedPositions,
    regimeChanges,
  }
}

function getSpacingForTier(tier: 'normal' | 'spike', params: ParamSet): number {
  if (tier === 'spike') return params.baseSpacingPct * 1.5  // wider during spike
  return params.baseSpacingPct
}

function placeGridHMM(center: number, spacing: number, alloc: number, lev: number): Array<{ price: number; side: 'BUY' | 'SELL'; quantity: number; filledAt?: number }> {
  const orders: Array<{ price: number; side: 'BUY' | 'SELL'; quantity: number; filledAt?: number }> = []
  const qty = (alloc * lev) / (4 * center)
  for (let i = 1; i <= 2; i++) {
    orders.push({ price: center * (1 - spacing * i), side: 'BUY', quantity: qty })
    orders.push({ price: center * (1 + spacing * i), side: 'SELL', quantity: qty })
  }
  return orders
}

function abandonPos(positions: Array<{ side: string; entryPrice: number; quantity: number }>, price: number): number {
  let total = 0
  for (const p of positions) {
    const gross = p.side === 'LONG' ? (price - p.entryPrice) * p.quantity : (p.entryPrice - price) * p.quantity
    total += gross - price * p.quantity * 0.0005
  }
  return total
}

function computeSharpe(returns: number[]): number {
  if (returns.length < 2) return 0
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)
  const std = Math.sqrt(variance)
  if (std === 0) return 0
  return (mean / std) * Math.sqrt(24 * 365)
}

function emptyResult(): BacktestResult {
  return { totalRoundTrips: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnlPerTrip: 0, maxDrawdown: 0, sharpeRatio: 0, fillRate: 0, compositeScore: 0, haltCount: 0, tiltPauses: 0, abandonedPositions: 0 }
}

// --- Main comparison ---

export async function runComparison(): Promise<ComparisonResult[]> {
  const results: ComparisonResult[] = []

  for (const pair of PAIRS) {
    const candles = await loadCandles(pair, 30)
    const hmmModel = loadHMMModel(pair)
    const alloc = ALLOCS[pair]

    // Test on last 10 days
    const testStart = Math.floor(candles.length * 0.67)
    const testCandles = candles.slice(testStart)
    const window = `${new Date(testCandles[0].openTime).toISOString().slice(0, 10)} → ${new Date(testCandles[testCandles.length - 1].openTime).toISOString().slice(0, 10)}`

    // Baseline: ADX thresholds
    const adxResult = runBacktest(testCandles, CURRENT_DEFAULTS, alloc, 5) as BacktestResult & { regimeChanges: number }
    // Count regime changes from the ADX backtest (approximate from abandoned positions)
    ;(adxResult as any).regimeChanges = adxResult.abandonedPositions

    // HMM variant
    const hmmResult = runBacktestHMM(testCandles, CURRENT_DEFAULTS, hmmModel, alloc, 5, 0.65)

    results.push({
      pair,
      window,
      adx: adxResult,
      hmm: hmmResult,
      delta: {
        winRate: `${((hmmResult.winRate - adxResult.winRate) * 100).toFixed(1)}%`,
        pnl: `$${(hmmResult.totalPnl - adxResult.totalPnl).toFixed(4)}`,
        abandoned: `${adxResult.abandonedPositions - hmmResult.abandonedPositions} fewer`,
        regimeChanges: `${(adxResult as any).regimeChanges - hmmResult.regimeChanges} fewer`,
        fillRate: `${(hmmResult.fillRate - adxResult.fillRate).toFixed(2)}/hr`,
      },
    })
  }

  return results
}

// CLI runner
if (require.main === module) {
  runComparison().then(results => {
    console.log('\n╔══════════════════════════════════════════════════════╗')
    console.log('║     REGIME DETECTOR COMPARISON: ADX vs HMM          ║')
    console.log('╚══════════════════════════════════════════════════════╝\n')

    for (const r of results) {
      const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length))
      console.log(r.pair + ' (' + r.window + '):')
      console.log('  ' + pad('Metric', 22) + pad('ADX (current)', 18) + pad('HMM (Markov)', 18) + 'Delta')
      console.log('  ' + '─'.repeat(70))
      console.log('  ' + pad('Win rate', 22) + pad((r.adx.winRate * 100).toFixed(1) + '%', 18) + pad((r.hmm.winRate * 100).toFixed(1) + '%', 18) + r.delta.winRate)
      console.log('  ' + pad('Total P&L', 22) + pad('$' + r.adx.totalPnl.toFixed(4), 18) + pad('$' + r.hmm.totalPnl.toFixed(4), 18) + r.delta.pnl)
      console.log('  ' + pad('Avg P&L/trip', 22) + pad('$' + r.adx.avgPnlPerTrip.toFixed(4), 18) + pad('$' + r.hmm.avgPnlPerTrip.toFixed(4), 18))
      console.log('  ' + pad('Round trips', 22) + pad(String(r.adx.totalRoundTrips), 18) + pad(String(r.hmm.totalRoundTrips), 18))
      console.log('  ' + pad('Wins / Losses', 22) + pad(r.adx.wins + '/' + r.adx.losses, 18) + pad(r.hmm.wins + '/' + r.hmm.losses, 18))
      console.log('  ' + pad('Abandoned', 22) + pad(String(r.adx.abandonedPositions), 18) + pad(String(r.hmm.abandonedPositions), 18) + r.delta.abandoned)
      console.log('  ' + pad('Regime changes', 22) + pad(String((r.adx as any).regimeChanges), 18) + pad(String(r.hmm.regimeChanges), 18) + r.delta.regimeChanges)
      console.log('  ' + pad('Fill rate', 22) + pad(r.adx.fillRate.toFixed(2) + '/hr', 18) + pad(r.hmm.fillRate.toFixed(2) + '/hr', 18) + r.delta.fillRate)
      console.log('  ' + pad('Max drawdown', 22) + pad((r.adx.maxDrawdown * 100).toFixed(2) + '%', 18) + pad((r.hmm.maxDrawdown * 100).toFixed(2) + '%', 18))
      console.log('')
    }

    process.exit(0)
  })
}
