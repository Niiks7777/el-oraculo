/**
 * Grid Backtest Engine v2 — Faithful to El Pesos mechanics
 *
 * Includes: ADX guard (4-tier), fee profitability guard, drawdown halt,
 * anti-tilt cooldowns, abandon-on-reposition losses, scoring aligned
 * with real learning engine (0.6*fillRate + 0.4*pnlPerTrip).
 */

import type { ParamSet } from './param-space'

export interface Candle {
  openTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface BacktestResult {
  totalRoundTrips: number
  wins: number
  losses: number
  winRate: number
  totalPnl: number
  avgPnlPerTrip: number
  maxDrawdown: number
  sharpeRatio: number
  fillRate: number
  compositeScore: number
  haltCount: number
  tiltPauses: number
  abandonedPositions: number
}

interface GridOrder {
  price: number
  side: 'BUY' | 'SELL'
  quantity: number
  filledAt?: number
}

interface OpenPosition {
  side: 'LONG' | 'SHORT'
  entryPrice: number
  quantity: number
  openedAt: number
}

const MAKER_FEE = 0.0002
const ROUND_TRIP_FEE_PCT = MAKER_FEE * 2  // 0.04%
const MIN_PROFITABLE_SPACING = ROUND_TRIP_FEE_PCT * 3  // 0.12%
const KILLSWITCH_LOSS = 50
const SOFT_HALT_DRAWDOWN = 0.10
const HARD_HALT_DRAWDOWN = 0.20
const SOFT_HALT_DURATION_MS = 30 * 60 * 1000
const ANTI_TILT_TIERS = [
  { losses: 5, cooldownMs: 5 * 60 * 1000 },
  { losses: 8, cooldownMs: 10 * 60 * 1000 },
  { losses: 12, cooldownMs: 20 * 60 * 1000 },
]

export function runBacktest(
  candles: Candle[],
  params: ParamSet,
  allocation: number,
  leverage = 5,
): BacktestResult {
  if (candles.length < 200) return emptyResult()

  // --- State ---
  let equity = allocation
  let sessionHigh = allocation
  let centerPrice = candles[0].close
  let gridOrders: GridOrder[] = []
  let openPositions: OpenPosition[] = []
  let totalFills = 0
  const roundTrips: number[] = []
  const hourlyReturns: number[] = []
  let hourlyPnl = 0
  let lastHour = Math.floor(candles[0].openTime / 3600000)

  // ADX state
  let currentAdxTier: 'neutral' | 'bias' | 'directional' | 'pause' = 'neutral'
  let lastAdxCheck = 0

  // Risk state
  let halted = false
  let haltUntil = 0
  let haltCount = 0
  let consecutiveLosses = 0
  let tiltCooldownUntil = 0
  let tiltPauses = 0
  let abandonedPositions = 0

  // Hourly candle aggregation for ADX
  const hourlyCandles: Candle[] = []
  let currentHourCandle: Candle | null = null

  // --- Main loop ---
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const hour = Math.floor(c.openTime / 3600000)

    // Aggregate to hourly for ADX
    if (!currentHourCandle || Math.floor(currentHourCandle.openTime / 3600000) !== hour) {
      if (currentHourCandle) hourlyCandles.push(currentHourCandle)
      currentHourCandle = { ...c }
    } else {
      currentHourCandle.high = Math.max(currentHourCandle.high, c.high)
      currentHourCandle.low = Math.min(currentHourCandle.low, c.low)
      currentHourCandle.close = c.close
      currentHourCandle.volume += c.volume
    }

    // Track hourly returns
    if (hour !== lastHour) {
      hourlyReturns.push(hourlyPnl)
      hourlyPnl = 0
      lastHour = hour
    }

    // --- Risk checks ---

    // Halt check
    if (halted) {
      if (c.openTime < haltUntil) continue
      halted = false  // Soft halt expired
    }

    // Anti-tilt cooldown
    if (c.openTime < tiltCooldownUntil) continue

    // Unrealized loss killswitch
    const unrealized = computeUnrealizedPnl(openPositions, c.close)
    if (unrealized < -KILLSWITCH_LOSS) {
      halted = true
      haltUntil = c.openTime + SOFT_HALT_DURATION_MS
      haltCount++
      continue
    }

    // Drawdown halt
    const currentEquity = equity + unrealized
    sessionHigh = Math.max(sessionHigh, currentEquity)
    const drawdown = sessionHigh > 0 ? (sessionHigh - currentEquity) / sessionHigh : 0

    if (drawdown >= HARD_HALT_DRAWDOWN) {
      halted = true
      haltUntil = c.openTime + 4 * 60 * 60 * 1000  // 4h for hard halt in backtest
      haltCount++
      continue
    }
    if (drawdown >= SOFT_HALT_DRAWDOWN) {
      halted = true
      haltUntil = c.openTime + SOFT_HALT_DURATION_MS
      haltCount++
      continue
    }

    // --- ADX Guard (every hour) ---
    if (c.openTime - lastAdxCheck >= 3600000 && hourlyCandles.length >= 30) {
      lastAdxCheck = c.openTime
      const adx = computeADX(hourlyCandles, 14)
      if (adx !== null) {
        const prevTier: string = currentAdxTier
        currentAdxTier = classifyAdxTier(adx, currentAdxTier, params)

        // Reposition on tier change
        if (currentAdxTier !== prevTier && currentAdxTier !== 'pause') {
          // Abandon open positions (loss) on reposition
          const abandonLoss = abandonPositions(openPositions, c.close)
          if (abandonLoss !== 0) {
            roundTrips.push(abandonLoss)
            equity += abandonLoss
            hourlyPnl += abandonLoss
            if (abandonLoss < 0) {
              consecutiveLosses++
              abandonedPositions++
            }
          }
          openPositions = []

          centerPrice = c.close
          gridOrders = placeGrid(centerPrice, params, allocation, leverage, currentAdxTier)
        }
      }
    }

    // Pause tier = no grid
    if (currentAdxTier === 'pause') continue

    // --- Fill detection ---
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
          openedAt: c.openTime,
        })
      }
    }

    // --- Counter fill detection (round-trip completion) ---
    const closed: OpenPosition[] = []
    for (const pos of openPositions) {
      const effectiveSpacing = getEffectiveSpacing(centerPrice, params, currentAdxTier)
      const exitPrice =
        pos.side === 'LONG'
          ? pos.entryPrice + centerPrice * effectiveSpacing
          : pos.entryPrice - centerPrice * effectiveSpacing

      const exitFilled =
        (pos.side === 'LONG' && c.high >= exitPrice) ||
        (pos.side === 'SHORT' && c.low <= exitPrice)

      if (exitFilled) {
        const grossPnl =
          pos.side === 'LONG'
            ? (exitPrice - pos.entryPrice) * pos.quantity
            : (pos.entryPrice - exitPrice) * pos.quantity

        const fees =
          pos.entryPrice * pos.quantity * MAKER_FEE +
          exitPrice * pos.quantity * MAKER_FEE

        const netPnl = grossPnl - fees
        roundTrips.push(netPnl)
        equity += netPnl
        hourlyPnl += netPnl
        sessionHigh = Math.max(sessionHigh, equity)

        if (netPnl > 0) {
          consecutiveLosses = 0
        } else {
          consecutiveLosses++
          // Anti-tilt check
          for (let t = ANTI_TILT_TIERS.length - 1; t >= 0; t--) {
            if (consecutiveLosses >= ANTI_TILT_TIERS[t].losses) {
              tiltCooldownUntil = c.openTime + ANTI_TILT_TIERS[t].cooldownMs
              tiltPauses++
              break
            }
          }
        }

        closed.push(pos)
      }
    }

    openPositions = openPositions.filter((p) => !closed.includes(p))

    // --- Reposition on price drift ---
    const drift = Math.abs(c.close - centerPrice) / centerPrice
    if (drift > params.repositionPct) {
      // Abandon unclosed positions (this is a LOSS in real trading)
      const abandonLoss = abandonPositions(openPositions, c.close)
      if (abandonLoss !== 0) {
        roundTrips.push(abandonLoss)
        equity += abandonLoss
        hourlyPnl += abandonLoss
        if (abandonLoss < 0) {
          consecutiveLosses++
          abandonedPositions++
        }
      }
      openPositions = []

      centerPrice = c.close
      gridOrders = placeGrid(centerPrice, params, allocation, leverage, currentAdxTier)
    }
  }

  // --- Final: abandon remaining positions at last close ---
  if (openPositions.length > 0) {
    const lastClose = candles[candles.length - 1].close
    const finalLoss = abandonPositions(openPositions, lastClose)
    if (finalLoss !== 0) {
      roundTrips.push(finalLoss)
      equity += finalLoss
      if (finalLoss < 0) abandonedPositions++
    }
  }

  // --- Compute metrics ---
  const wins = roundTrips.filter((p) => p > 0).length
  const losses = roundTrips.filter((p) => p <= 0).length
  const totalPnl = roundTrips.reduce((s, p) => s + p, 0)
  const totalTrips = roundTrips.length
  const winRate = totalTrips > 0 ? wins / totalTrips : 0
  const avgPnlPerTrip = totalTrips > 0 ? totalPnl / totalTrips : 0
  const maxDrawdown = sessionHigh > 0 ? (sessionHigh - Math.min(equity, sessionHigh)) / sessionHigh : 0
  const hours = candles.length / 60
  const fillRate = hours > 0 ? totalFills / hours : 0
  const sharpeRatio = computeSharpe(hourlyReturns)

  // Scoring aligned with REAL learning engine: 0.6*fillRate + 0.4*pnlPerTrip
  const normalizedFillRate = Math.min(fillRate / 10, 1.0)
  const normalizedPnlPerTrip = Math.min(Math.max(avgPnlPerTrip, 0) / 1.0, 1.0)
  const compositeScore = normalizedFillRate * 0.6 + normalizedPnlPerTrip * 0.4

  return {
    totalRoundTrips: totalTrips,
    wins,
    losses,
    winRate,
    totalPnl,
    avgPnlPerTrip,
    maxDrawdown,
    sharpeRatio,
    fillRate,
    compositeScore,
    haltCount,
    tiltPauses,
    abandonedPositions,
  }
}

// --- ADX Guard ---

function classifyAdxTier(
  adx: number,
  prevTier: string,
  params: ParamSet,
): 'neutral' | 'bias' | 'directional' | 'pause' {
  const hysteresis = 5

  // Escalation (immediate)
  if (adx >= params.adxDirectional) return 'pause'
  if (adx >= params.adxBias) return 'directional'
  if (adx >= params.adxNeutral) return 'bias'

  // De-escalation (with hysteresis)
  if (prevTier === 'pause' && adx >= params.adxDirectional - hysteresis) return 'pause'
  if (prevTier === 'directional' && adx >= params.adxBias - hysteresis) return 'directional'
  if (prevTier === 'bias' && adx >= params.adxNeutral - hysteresis) return 'bias'

  return 'neutral'
}

function getEffectiveSpacing(
  centerPrice: number,
  params: ParamSet,
  adxTier: string,
): number {
  let spacing = params.baseSpacingPct

  // Fee profitability guard
  if (spacing < MIN_PROFITABLE_SPACING) {
    spacing = MIN_PROFITABLE_SPACING
  }

  // ADX multiplier
  if (adxTier === 'bias') spacing *= params.biasSpacingMult
  else if (adxTier === 'directional') spacing *= params.directionalSpacingMult

  // Clamp
  return Math.max(0.0025, Math.min(0.006, spacing))
}

function placeGrid(
  center: number,
  params: ParamSet,
  allocation: number,
  leverage: number,
  adxTier: string,
): GridOrder[] {
  const orders: GridOrder[] = []
  const effectiveSpacing = getEffectiveSpacing(center, params, adxTier)
  const totalLevels = 4

  // Determine buy/sell split based on ADX tier
  let buyLevels = 2
  let sellLevels = 2

  if (adxTier === 'directional') {
    // Simplified: assume trend direction based on recent price action
    // In real engine, uses EMA 9/21 crossover. Here we use a coin flip
    // weighted by the grid's center vs first candle direction
    buyLevels = 3  // Default to long bias (can be randomized)
    sellLevels = 1
  }

  const qtyPerOrder = (allocation * leverage) / (totalLevels * center)

  for (let i = 1; i <= buyLevels; i++) {
    orders.push({
      price: center * (1 - effectiveSpacing * i),
      side: 'BUY',
      quantity: qtyPerOrder,
    })
  }
  for (let i = 1; i <= sellLevels; i++) {
    orders.push({
      price: center * (1 + effectiveSpacing * i),
      side: 'SELL',
      quantity: qtyPerOrder,
    })
  }

  return orders
}

// --- Position Management ---

function computeUnrealizedPnl(positions: OpenPosition[], currentPrice: number): number {
  let total = 0
  for (const pos of positions) {
    if (pos.side === 'LONG') {
      total += (currentPrice - pos.entryPrice) * pos.quantity
    } else {
      total += (pos.entryPrice - currentPrice) * pos.quantity
    }
  }
  return total
}

function abandonPositions(positions: OpenPosition[], currentPrice: number): number {
  let totalPnl = 0
  for (const pos of positions) {
    const grossPnl =
      pos.side === 'LONG'
        ? (currentPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - currentPrice) * pos.quantity
    // Taker fee on market close (not maker)
    const fee = currentPrice * pos.quantity * 0.0005  // taker fee for forced close
    totalPnl += grossPnl - fee
  }
  return totalPnl
}

// --- ADX Calculation (Wilder's method, period 14) ---

function computeADX(hourlyCandles: Candle[], period = 14): number | null {
  if (hourlyCandles.length < period * 2 + 1) return null

  const len = hourlyCandles.length
  const trueRanges: number[] = []
  const plusDMs: number[] = []
  const minusDMs: number[] = []

  for (let i = 1; i < len; i++) {
    const h = hourlyCandles[i].high
    const l = hourlyCandles[i].low
    const pc = hourlyCandles[i - 1].close

    trueRanges.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))

    const upMove = h - hourlyCandles[i - 1].high
    const downMove = hourlyCandles[i - 1].low - l

    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0)
  }

  // Smoothed averages (Wilder's)
  let atr = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period
  let smoothPlusDM = plusDMs.slice(0, period).reduce((s, v) => s + v, 0) / period
  let smoothMinusDM = minusDMs.slice(0, period).reduce((s, v) => s + v, 0) / period

  const dxValues: number[] = []

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period
    smoothPlusDM = (smoothPlusDM * (period - 1) + plusDMs[i]) / period
    smoothMinusDM = (smoothMinusDM * (period - 1) + minusDMs[i]) / period

    const plusDI = atr > 0 ? (smoothPlusDM / atr) * 100 : 0
    const minusDI = atr > 0 ? (smoothMinusDM / atr) * 100 : 0
    const diSum = plusDI + minusDI
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0
    dxValues.push(dx)
  }

  if (dxValues.length < period) return null

  // ADX = smoothed DX
  let adx = dxValues.slice(0, period).reduce((s, v) => s + v, 0) / period
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period
  }

  return adx
}

// --- Utilities ---

function computeSharpe(returns: number[]): number {
  if (returns.length < 2) return 0
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance =
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)
  const std = Math.sqrt(variance)
  if (std === 0) return 0
  return (mean / std) * Math.sqrt(24 * 365)
}

function emptyResult(): BacktestResult {
  return {
    totalRoundTrips: 0, wins: 0, losses: 0, winRate: 0,
    totalPnl: 0, avgPnlPerTrip: 0, maxDrawdown: 0, sharpeRatio: 0,
    fillRate: 0, compositeScore: 0, haltCount: 0, tiltPauses: 0,
    abandonedPositions: 0,
  }
}
