/**
 * Historical Pattern Analyzer
 * Reads deep candle history to identify:
 * - Volatility regimes and their durations
 * - Optimal spacing per regime
 * - Time-of-day patterns
 * - Drawdown events and recovery patterns
 * - Mean reversion characteristics per pair
 * - Trend vs range detection accuracy
 */

import type { Candle } from './backtest-engine'
import { runBacktest, type BacktestResult } from './backtest-engine'
import { scoreResult, type ScoreBreakdown } from './scoring'
import type { ParamSet } from './param-space'
import { CURRENT_DEFAULTS } from './param-space'

export interface VolatilityRegime {
  label: 'low' | 'medium' | 'high' | 'extreme'
  avgAtrPct: number
  durationHours: number
  startTime: number
  endTime: number
}

export interface TimeOfDayProfile {
  hour: number
  avgVolatility: number
  avgRange: number
  avgVolume: number
  bestSpacingPct: number
  fillsPerHour: number
}

export interface MeanReversionProfile {
  symbol: string
  avgBounceFromLow: number
  avgBounceFromHigh: number
  medianRangePercent: number
  avgCandleBody: number
  wickRatio: number
  trendiness: number // 0=pure range, 1=pure trend
}

export interface DrawdownEvent {
  startTime: number
  endTime: number
  depth: number
  recoveryHours: number
  cause: string
}

export interface PatternInsights {
  symbol: string
  period: string
  totalCandles: number
  volatilityRegimes: VolatilityRegime[]
  timeOfDayProfile: TimeOfDayProfile[]
  meanReversion: MeanReversionProfile
  drawdownEvents: DrawdownEvent[]
  weeklyBacktests: Array<{
    weekStart: string
    result: BacktestResult
    score: number
  }>
  optimalParams: {
    lowVolSpacing: number
    highVolSpacing: number
    bestTimeOfDay: number[]
    worstTimeOfDay: number[]
  }
  summary: string[]
}

export function analyzePatterns(
  candles: Candle[],
  symbol: string,
  allocation: number,
): PatternInsights {
  const period = `${new Date(candles[0].openTime).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1].openTime).toISOString().slice(0, 10)}`

  // 1. Volatility regimes
  const regimes = detectVolatilityRegimes(candles)

  // 2. Time-of-day analysis
  const todProfile = analyzeTimeOfDay(candles)

  // 3. Mean reversion characteristics
  const meanRev = analyzeMeanReversion(candles, symbol)

  // 4. Drawdown events
  const drawdowns = detectDrawdowns(candles)

  // 5. Weekly backtests (rolling windows)
  const weeklyResults = runWeeklyBacktests(candles, allocation)

  // 6. Optimal parameters per regime
  const optimal = findOptimalParams(candles, allocation, regimes, todProfile)

  // 7. Generate summary insights
  const summary = generateSummary(
    symbol, regimes, todProfile, meanRev, drawdowns, weeklyResults, optimal,
  )

  return {
    symbol,
    period,
    totalCandles: candles.length,
    volatilityRegimes: regimes,
    timeOfDayProfile: todProfile,
    meanReversion: meanRev,
    drawdownEvents: drawdowns,
    weeklyBacktests: weeklyResults,
    optimalParams: optimal,
    summary,
  }
}

function computeATR(candles: Candle[], period = 14): number[] {
  const atrs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    )
    if (i < period) {
      atrs.push(tr)
    } else {
      const prev = atrs[atrs.length - 1] ?? tr
      atrs.push((prev * (period - 1) + tr) / period)
    }
  }
  return atrs
}

function detectVolatilityRegimes(candles: Candle[]): VolatilityRegime[] {
  const hourlyCandles = aggregateToHourly(candles)
  const atrs = computeATR(hourlyCandles, 14)

  // Compute ATR percentages
  const atrPcts = atrs.map((atr, i) => {
    const price = hourlyCandles[Math.min(i + 1, hourlyCandles.length - 1)].close
    return price > 0 ? (atr / price) * 100 : 0
  })

  // Percentiles for regime classification
  const sorted = [...atrPcts].sort((a, b) => a - b)
  const p25 = sorted[Math.floor(sorted.length * 0.25)]
  const p75 = sorted[Math.floor(sorted.length * 0.75)]
  const p95 = sorted[Math.floor(sorted.length * 0.95)]

  // Group consecutive hours into regimes
  const regimes: VolatilityRegime[] = []
  let currentLabel: VolatilityRegime['label'] = 'medium'
  let regimeStart = 0

  for (let i = 0; i < atrPcts.length; i++) {
    const v = atrPcts[i]
    const label: VolatilityRegime['label'] =
      v <= p25 ? 'low' : v <= p75 ? 'medium' : v <= p95 ? 'high' : 'extreme'

    if (label !== currentLabel || i === atrPcts.length - 1) {
      if (i > regimeStart) {
        const slice = atrPcts.slice(regimeStart, i)
        regimes.push({
          label: currentLabel,
          avgAtrPct: slice.reduce((s, v) => s + v, 0) / slice.length,
          durationHours: i - regimeStart,
          startTime: hourlyCandles[regimeStart]?.openTime ?? 0,
          endTime: hourlyCandles[Math.min(i, hourlyCandles.length - 1)]?.openTime ?? 0,
        })
      }
      currentLabel = label
      regimeStart = i
    }
  }

  return regimes
}

function analyzeTimeOfDay(candles: Candle[]): TimeOfDayProfile[] {
  const hourBuckets: Record<number, { vol: number[]; range: number[]; volume: number[] }> = {}

  for (let h = 0; h < 24; h++) {
    hourBuckets[h] = { vol: [], range: [], volume: [] }
  }

  for (const c of candles) {
    const hour = new Date(c.openTime).getUTCHours()
    const range = c.high > 0 ? ((c.high - c.low) / c.close) * 100 : 0
    const body = c.close > 0 ? (Math.abs(c.close - c.open) / c.close) * 100 : 0
    hourBuckets[hour].vol.push(body)
    hourBuckets[hour].range.push(range)
    hourBuckets[hour].volume.push(c.volume)
  }

  return Object.entries(hourBuckets).map(([h, data]) => {
    const avgVol = avg(data.vol)
    const avgRange = avg(data.range)
    const avgVolume = avg(data.volume)
    // Optimal spacing scales with volatility
    const bestSpacing = Math.max(0.0025, Math.min(0.006, avgRange * 0.4))

    return {
      hour: parseInt(h),
      avgVolatility: avgVol,
      avgRange: avgRange,
      avgVolume: avgVolume,
      bestSpacingPct: bestSpacing,
      fillsPerHour: 0, // filled by backtest
    }
  })
}

function analyzeMeanReversion(candles: Candle[], symbol: string): MeanReversionProfile {
  const bounceFromLows: number[] = []
  const bounceFromHighs: number[] = []
  const ranges: number[] = []
  const bodies: number[] = []
  const wicks: number[] = []

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    const prev = candles[i - 1]
    const range = c.close > 0 ? (c.high - c.low) / c.close : 0
    const body = c.close > 0 ? Math.abs(c.close - c.open) / c.close : 0
    const upperWick = c.high - Math.max(c.open, c.close)
    const lowerWick = Math.min(c.open, c.close) - c.low
    const totalWick = upperWick + lowerWick

    ranges.push(range * 100)
    bodies.push(body * 100)
    wicks.push(range > 0 ? totalWick / (c.high - c.low) : 0)

    // Bounce from low: how much price recovered from candle low
    if (c.low < prev.low) {
      const bounce = (c.close - c.low) / (c.high - c.low || 1)
      bounceFromLows.push(bounce)
    }
    if (c.high > prev.high) {
      const bounce = (c.high - c.close) / (c.high - c.low || 1)
      bounceFromHighs.push(bounce)
    }
  }

  // Trendiness: ratio of net movement to total movement
  const totalMove = candles.reduce((s, c) => s + Math.abs(c.close - c.open), 0)
  const netMove = Math.abs(candles[candles.length - 1].close - candles[0].open)
  const trendiness = totalMove > 0 ? netMove / totalMove : 0

  return {
    symbol,
    avgBounceFromLow: avg(bounceFromLows),
    avgBounceFromHigh: avg(bounceFromHighs),
    medianRangePercent: median(ranges),
    avgCandleBody: avg(bodies),
    wickRatio: avg(wicks),
    trendiness,
  }
}

function detectDrawdowns(candles: Candle[]): DrawdownEvent[] {
  const events: DrawdownEvent[] = []
  let peak = candles[0].close
  let trough = candles[0].close
  let inDrawdown = false
  let drawdownStart = 0

  for (const c of candles) {
    if (c.close > peak) {
      if (inDrawdown) {
        const depth = (peak - trough) / peak
        if (depth > 0.02) { // >2% drawdown
          events.push({
            startTime: drawdownStart,
            endTime: c.openTime,
            depth,
            recoveryHours: (c.openTime - drawdownStart) / 3600000,
            cause: depth > 0.05 ? 'major_move' : 'normal_volatility',
          })
        }
        inDrawdown = false
      }
      peak = c.close
      trough = c.close
    } else if (c.close < trough) {
      if (!inDrawdown) {
        drawdownStart = c.openTime
        inDrawdown = true
      }
      trough = c.close
    }
  }

  return events.sort((a, b) => b.depth - a.depth).slice(0, 20)
}

function runWeeklyBacktests(
  candles: Candle[],
  allocation: number,
): Array<{ weekStart: string; result: BacktestResult; score: number }> {
  const results: Array<{ weekStart: string; result: BacktestResult; score: number }> = []
  const weekMs = 7 * 24 * 60 * 60 * 1000
  const startTime = candles[0].openTime

  for (let weekStart = startTime; weekStart + weekMs <= candles[candles.length - 1].openTime; weekStart += weekMs) {
    const weekEnd = weekStart + weekMs
    const weekCandles = candles.filter(
      (c) => c.openTime >= weekStart && c.openTime < weekEnd,
    )

    if (weekCandles.length < 1000) continue

    const result = runBacktest(weekCandles, CURRENT_DEFAULTS, allocation, 5)
    const score = scoreResult(result, allocation)

    results.push({
      weekStart: new Date(weekStart).toISOString().slice(0, 10),
      result,
      score: score.totalScore,
    })
  }

  return results
}

function findOptimalParams(
  candles: Candle[],
  allocation: number,
  regimes: VolatilityRegime[],
  todProfile: TimeOfDayProfile[],
): PatternInsights['optimalParams'] {
  // Find low/high vol optimal spacing
  const lowVolRegimes = regimes.filter((r) => r.label === 'low')
  const highVolRegimes = regimes.filter((r) => r.label === 'high' || r.label === 'extreme')

  const lowVolAvgAtr = lowVolRegimes.length > 0
    ? lowVolRegimes.reduce((s, r) => s + r.avgAtrPct, 0) / lowVolRegimes.length
    : 0.1
  const highVolAvgAtr = highVolRegimes.length > 0
    ? highVolRegimes.reduce((s, r) => s + r.avgAtrPct, 0) / highVolRegimes.length
    : 0.5

  // ToD: sort by range to find best/worst
  const sorted = [...todProfile].sort((a, b) => a.avgRange - b.avgRange)
  const calmest = sorted.slice(0, 4).map((t) => t.hour)
  const wildest = sorted.slice(-4).map((t) => t.hour)

  return {
    lowVolSpacing: Math.max(0.0025, lowVolAvgAtr * 0.003),
    highVolSpacing: Math.min(0.006, highVolAvgAtr * 0.003),
    bestTimeOfDay: calmest,
    worstTimeOfDay: wildest,
  }
}

function generateSummary(
  symbol: string,
  regimes: VolatilityRegime[],
  todProfile: TimeOfDayProfile[],
  meanRev: MeanReversionProfile,
  drawdowns: DrawdownEvent[],
  weeklyResults: Array<{ weekStart: string; result: BacktestResult; score: number }>,
  optimal: PatternInsights['optimalParams'],
): string[] {
  const insights: string[] = []

  // Regime distribution
  const regimeCounts: Record<string, number> = { low: 0, medium: 0, high: 0, extreme: 0 }
  const regimeHours: Record<string, number> = { low: 0, medium: 0, high: 0, extreme: 0 }
  for (const r of regimes) {
    regimeCounts[r.label]++
    regimeHours[r.label] += r.durationHours
  }
  const totalHours = Object.values(regimeHours).reduce((s, h) => s + h, 0)

  insights.push(
    `${symbol} regime distribution: Low ${((regimeHours.low / totalHours) * 100).toFixed(0)}% | Med ${((regimeHours.medium / totalHours) * 100).toFixed(0)}% | High ${((regimeHours.high / totalHours) * 100).toFixed(0)}% | Extreme ${((regimeHours.extreme / totalHours) * 100).toFixed(0)}%`,
  )

  // Mean reversion strength
  insights.push(
    `Mean reversion: bounce from low ${(meanRev.avgBounceFromLow * 100).toFixed(1)}% | bounce from high ${(meanRev.avgBounceFromHigh * 100).toFixed(1)}% | trendiness ${(meanRev.trendiness * 100).toFixed(1)}%`,
  )

  // Best/worst hours
  const sortedTod = [...todProfile].sort((a, b) => b.avgRange - a.avgRange)
  insights.push(
    `Most volatile hours (UTC): ${sortedTod.slice(0, 3).map((t) => t.hour + ':00').join(', ')} | Calmest: ${sortedTod.slice(-3).map((t) => t.hour + ':00').join(', ')}`,
  )

  // Wick ratio insight
  if (meanRev.wickRatio > 0.6) {
    insights.push(
      `High wick ratio (${(meanRev.wickRatio * 100).toFixed(0)}%) — strong mean reversion, grid strategy favorable`,
    )
  } else if (meanRev.wickRatio < 0.3) {
    insights.push(
      `Low wick ratio (${(meanRev.wickRatio * 100).toFixed(0)}%) — trending behavior, consider wider spacing`,
    )
  }

  // Weekly consistency
  if (weeklyResults.length > 1) {
    const scores = weeklyResults.map((w) => w.score)
    const minScore = Math.min(...scores)
    const maxScore = Math.max(...scores)
    const consistency = 1 - (maxScore - minScore)
    insights.push(
      `Weekly score range: ${minScore.toFixed(4)} → ${maxScore.toFixed(4)} (consistency: ${(consistency * 100).toFixed(1)}%)`,
    )

    const bestWeek = weeklyResults.reduce((best, w) => (w.score > best.score ? w : best))
    const worstWeek = weeklyResults.reduce((worst, w) => (w.score < worst.score ? w : worst))
    insights.push(
      `Best week: ${bestWeek.weekStart} (${bestWeek.result.totalRoundTrips} trips, $${bestWeek.result.totalPnl.toFixed(2)}) | Worst: ${worstWeek.weekStart} ($${worstWeek.result.totalPnl.toFixed(2)})`,
    )
  }

  // Drawdowns
  if (drawdowns.length > 0) {
    const worst = drawdowns[0]
    insights.push(
      `Deepest drawdown: ${(worst.depth * 100).toFixed(1)}% over ${worst.recoveryHours.toFixed(1)}h (${worst.cause})`,
    )
    const avgRecovery = drawdowns.reduce((s, d) => s + d.recoveryHours, 0) / drawdowns.length
    insights.push(
      `${drawdowns.length} drawdowns >2%, avg recovery: ${avgRecovery.toFixed(1)} hours`,
    )
  }

  // Spacing recommendation
  insights.push(
    `Suggested low-vol spacing: ${(optimal.lowVolSpacing * 100).toFixed(3)}% | high-vol: ${(optimal.highVolSpacing * 100).toFixed(3)}%`,
  )

  return insights
}

function aggregateToHourly(candles: Candle[]): Candle[] {
  const hourly: Candle[] = []
  let current: Candle | null = null

  for (const c of candles) {
    const hourStart = Math.floor(c.openTime / 3600000) * 3600000
    if (!current || current.openTime !== hourStart) {
      if (current) hourly.push(current)
      current = { ...c, openTime: hourStart }
    } else {
      current.high = Math.max(current.high, c.high)
      current.low = Math.min(current.low, c.low)
      current.close = c.close
      current.volume += c.volume
    }
  }
  if (current) hourly.push(current)
  return hourly
}

function avg(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}
