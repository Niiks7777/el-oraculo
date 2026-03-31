/**
 * Autoresearch Loop Runner
 * Adapted from Karpathy's autoresearch pattern for grid parameter optimization.
 *
 * Loop: propose param change → backtest → score → keep/revert → signal → repeat
 */

import * as fs from 'fs'
import { CONFIG } from '../config'
import {
  type ParamSet,
  CURRENT_DEFAULTS,
  PARAM_BOUNDS,
  clampParams,
  maxChangePct,
} from './param-space'
import { runBacktest, type Candle } from './backtest-engine'
import { scoreResult, isImprovement, type ScoreBreakdown } from './scoring'
import { loadCandles } from './history-loader'
import { analyzePatterns, type PatternInsights } from './pattern-analyzer'
import { createSignal } from '../orchestrator/signal-bus'
import { getMultiplier } from '../orchestrator/confidence-tracker'
import { sendTelegram } from '../orchestrator/telegram-sender'
import pino from 'pino'

const log = pino({ name: 'autoresearch' })
const RESULTS_FILE = './autoresearch-results.tsv'
const STATE_FILE = './autoresearch-state.json'

const SYMBOLS = ['ETHUSDT', 'SOLUSDT', 'TAOUSDT']
const ALLOCATIONS: Record<string, number> = {
  ETHUSDT: 55,
  SOLUSDT: 35,
  TAOUSDT: 40,
}

interface LoopState {
  currentParams: ParamSet
  baselineScore: number
  iteration: number
  totalKept: number
  totalDiscarded: number
  lastRunAt: number
}

function loadState(): LoopState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
  } catch {
    return {
      currentParams: { ...CURRENT_DEFAULTS },
      baselineScore: 0,
      iteration: 0,
      totalKept: 0,
      totalDiscarded: 0,
      lastRunAt: 0,
    }
  }
}

function saveState(state: LoopState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function initResultsTsv(): void {
  if (!fs.existsSync(RESULTS_FILE)) {
    fs.writeFileSync(
      RESULTS_FILE,
      'iteration\tscore\tbaseline\tstatus\tparam_changed\told_value\tnew_value\tdescription\n',
    )
  }
}

function logResult(
  iteration: number,
  score: number,
  baseline: number,
  status: 'keep' | 'discard',
  param: string,
  oldVal: number,
  newVal: number,
  description: string,
): void {
  fs.appendFileSync(
    RESULTS_FILE,
    `${iteration}\t${score.toFixed(6)}\t${baseline.toFixed(6)}\t${status}\t${param}\t${oldVal}\t${newVal}\t${description}\n`,
  )
}

function proposeChange(
  current: ParamSet,
  iteration: number,
  patternHints?: Record<string, PatternInsights>,
): {
  params: ParamSet
  changedParam: string
  oldValue: number
  newValue: number
  description: string
} {
  const keys = Object.keys(PARAM_BOUNDS) as Array<keyof ParamSet>

  // Use pattern insights to bias proposals toward high-impact params
  let key: keyof ParamSet
  let direction: number
  let reason = ''

  if (patternHints && Math.random() < 0.6) {
    // 60% chance: pattern-guided proposal
    const guided = patternGuidedProposal(current, patternHints)
    key = guided.key
    direction = guided.direction
    reason = guided.reason
  } else {
    // 40% chance: random exploration
    const keyIdx = (iteration + Math.floor(Math.random() * 3)) % keys.length
    key = keys[keyIdx]
    direction = Math.random() > 0.5 ? 1 : -1
    reason = 'exploration'
  }

  const bounds = PARAM_BOUNDS[key]
  const oldValue = current[key]
  const stepSize = bounds.step * (1 + Math.floor(Math.random() * 2))
  let newValue = oldValue + direction * stepSize

  newValue = Math.max(bounds.min, Math.min(bounds.max, newValue))
  newValue = Math.round(newValue / bounds.step) * bounds.step

  if (Math.abs(newValue - oldValue) < bounds.step * 0.5) {
    newValue = oldValue + (direction > 0 ? bounds.step : -bounds.step)
    newValue = Math.max(bounds.min, Math.min(bounds.max, newValue))
  }

  const modified = { ...current, [key]: newValue }
  const dirLabel = direction > 0 ? 'increase' : 'decrease'
  const description = `${key}: ${oldValue} → ${newValue} (${dirLabel}, ${reason})`

  return {
    params: clampParams(modified),
    changedParam: key,
    oldValue,
    newValue,
    description,
  }
}

function patternGuidedProposal(
  current: ParamSet,
  hints: Record<string, PatternInsights>,
): { key: keyof ParamSet; direction: number; reason: string } {
  // Aggregate insights across pairs
  const allInsights = Object.values(hints)

  // Check if high wick ratio (mean-reverting) → tighten spacing
  const avgWick = allInsights.reduce((s, h) => s + h.meanReversion.wickRatio, 0) / allInsights.length
  if (avgWick > 0.5 && current.baseSpacingPct > 0.003) {
    return { key: 'baseSpacingPct', direction: -1, reason: `high wick ratio ${(avgWick * 100).toFixed(0)}% favors tighter spacing` }
  }

  // Check if drawdowns are deep → widen spacing for safety
  const maxDD = Math.max(...allInsights.flatMap(h => h.drawdownEvents.map(d => d.depth)))
  if (maxDD > 0.15 && current.baseSpacingPct < 0.005) {
    return { key: 'baseSpacingPct', direction: 1, reason: `deep drawdowns (${(maxDD * 100).toFixed(0)}%) suggest wider spacing` }
  }

  // Check TAO fill rate vs others — if TAO dominates, increase its allocation
  const taoInsight = hints['TAOUSDT']
  const ethInsight = hints['ETHUSDT']
  if (taoInsight && ethInsight) {
    const taoTrips = taoInsight.weeklyBacktests.reduce((s, w) => s + w.result.totalRoundTrips, 0)
    const ethTrips = ethInsight.weeklyBacktests.reduce((s, w) => s + w.result.totalRoundTrips, 0)
    if (taoTrips > ethTrips * 2 && current.taoAllocation < 50) {
      return { key: 'taoAllocation', direction: 1, reason: `TAO ${taoTrips} trips vs ETH ${ethTrips} — increase TAO allocation` }
    }
  }

  // Check if low trendiness → lower ADX thresholds (more time in neutral=tighter grid)
  const avgTrend = allInsights.reduce((s, h) => s + h.meanReversion.trendiness, 0) / allInsights.length
  if (avgTrend < 0.02 && current.adxNeutral > 18) {
    return { key: 'adxNeutral', direction: -1, reason: `low trendiness ${(avgTrend * 100).toFixed(1)}% — lower ADX neutral threshold` }
  }

  // Check reposition frequency — if too many repositions, widen threshold
  const avgDD = allInsights.reduce((s, h) => {
    const total = h.drawdownEvents.length
    return s + total
  }, 0) / allInsights.length
  if (avgDD > 10 && current.repositionPct < 0.02) {
    return { key: 'repositionPct', direction: 1, reason: `frequent repositions — widen reposition threshold` }
  }

  // Default: explore ATR spacing multiplier
  const atrDir = current.atrSpacingMult > 0.3 ? -1 : 1
  return { key: 'atrSpacingMult', direction: atrDir, reason: 'ATR mult exploration' }
}

async function backtestAcrossSymbols(
  params: ParamSet,
  candles: Record<string, Candle[]>,
): Promise<{ avgScore: number; breakdown: Record<string, ScoreBreakdown> }> {
  const breakdown: Record<string, ScoreBreakdown> = {}
  let totalScore = 0

  for (const symbol of SYMBOLS) {
    const symbolCandles = candles[symbol]
    if (!symbolCandles || symbolCandles.length === 0) continue

    const allocation = ALLOCATIONS[symbol] ?? 40
    const result = runBacktest(symbolCandles, params, allocation, 5)
    const score = scoreResult(result, allocation)
    breakdown[symbol] = score
    totalScore += score.totalScore
  }

  const activePairs = Object.keys(breakdown).length
  return {
    avgScore: activePairs > 0 ? totalScore / activePairs : 0,
    breakdown,
  }
}

export async function runAutoresearchCycle(): Promise<void> {
  const state = loadState()
  initResultsTsv()

  log.info(
    {
      iteration: state.iteration,
      kept: state.totalKept,
      discarded: state.totalDiscarded,
    },
    'Autoresearch cycle starting',
  )

  // Load candles — 7 days for backtesting, 30 days for pattern analysis
  const candles: Record<string, Candle[]> = {}
  const deepCandles: Record<string, Candle[]> = {}
  const patternHints: Record<string, PatternInsights> = {}

  for (const symbol of SYMBOLS) {
    candles[symbol] = await loadCandles(symbol, CONFIG.autoresearch.backtestDays)
    deepCandles[symbol] = await loadCandles(symbol, 30)
    log.info({ symbol, candles: candles[symbol].length, deep: deepCandles[symbol].length }, 'Candles loaded')

    // Run pattern analysis on 30-day window
    const allocation = ALLOCATIONS[symbol] ?? 40
    patternHints[symbol] = analyzePatterns(deepCandles[symbol], symbol, allocation)
    log.info(
      { symbol, insights: patternHints[symbol].summary.length },
      'Pattern analysis complete',
    )
  }

  // Establish baseline if needed
  if (state.baselineScore === 0) {
    const baseline = await backtestAcrossSymbols(state.currentParams, candles)
    state.baselineScore = baseline.avgScore
    logResult(0, baseline.avgScore, 0, 'keep', 'baseline', 0, 0, 'Initial baseline')
    saveState(state)
    log.info({ baselineScore: state.baselineScore }, 'Baseline established')
  }

  // Run iterations
  const maxIterations = CONFIG.autoresearch.maxIterationsPerCycle
  const minImprovement = CONFIG.autoresearch.minImprovementPct
  const maxChange = CONFIG.autoresearch.maxParamChangePct

  for (let i = 0; i < maxIterations; i++) {
    state.iteration++

    // Propose change (pattern-guided 60% of the time)
    const proposal = proposeChange(state.currentParams, state.iteration, patternHints)

    // Check max change constraint
    if (maxChangePct(state.currentParams, proposal.params) > maxChange) {
      log.debug(
        { param: proposal.changedParam },
        'Change exceeds max — skipping',
      )
      continue
    }

    // Backtest with proposed params
    const candidateResult = await backtestAcrossSymbols(proposal.params, candles)
    const baselineResult = await backtestAcrossSymbols(state.currentParams, candles)

    const baselineBreakdown = {
      totalScore: baselineResult.avgScore,
    } as ScoreBreakdown
    const candidateBreakdown = {
      totalScore: candidateResult.avgScore,
    } as ScoreBreakdown

    if (isImprovement(baselineBreakdown, candidateBreakdown, minImprovement)) {
      // KEEP
      state.currentParams = proposal.params
      state.baselineScore = candidateResult.avgScore
      state.totalKept++

      logResult(
        state.iteration,
        candidateResult.avgScore,
        baselineResult.avgScore,
        'keep',
        proposal.changedParam,
        proposal.oldValue,
        proposal.newValue,
        proposal.description,
      )

      log.info(
        {
          iteration: state.iteration,
          param: proposal.changedParam,
          old: proposal.oldValue,
          new: proposal.newValue,
          score: candidateResult.avgScore.toFixed(4),
          improvement: (
            ((candidateResult.avgScore - baselineResult.avgScore) /
              baselineResult.avgScore) *
            100
          ).toFixed(2) + '%',
        },
        'KEEP — improvement found',
      )

      // Create signal for El Pesos
      createSignal(
        {
          source: 'autoresearch',
          confidence: Math.min(0.85, 0.5 + candidateResult.avgScore),
          type: 'param_change',
          ttlHours: 12,
          payload: {
            parameter: proposal.changedParam,
            oldValue: proposal.oldValue,
            newValue: proposal.newValue,
            backtestScore: candidateResult.avgScore,
            baselineScore: baselineResult.avgScore,
          },
          reasoning: `Backtest over ${CONFIG.autoresearch.backtestDays} days shows ${proposal.description} improves composite score from ${baselineResult.avgScore.toFixed(4)} to ${candidateResult.avgScore.toFixed(4)}`,
        },
        getMultiplier(),
      )
    } else {
      // DISCARD
      state.totalDiscarded++

      logResult(
        state.iteration,
        candidateResult.avgScore,
        baselineResult.avgScore,
        'discard',
        proposal.changedParam,
        proposal.oldValue,
        proposal.newValue,
        proposal.description,
      )

      log.debug(
        {
          iteration: state.iteration,
          param: proposal.changedParam,
          candidateScore: candidateResult.avgScore.toFixed(4),
          baselineScore: baselineResult.avgScore.toFixed(4),
        },
        'DISCARD — no improvement',
      )
    }

    saveState(state)
  }

  // Summary
  log.info(
    {
      iterations: maxIterations,
      kept: state.totalKept,
      discarded: state.totalDiscarded,
      currentScore: state.baselineScore.toFixed(4),
    },
    'Autoresearch cycle complete',
  )

  await sendTelegram(
    `🔬 *Autoresearch Cycle Complete*\nIterations: ${maxIterations}\nKept: ${state.totalKept} | Discarded: ${state.totalDiscarded}\nCurrent score: ${state.baselineScore.toFixed(4)}`,
  )

  state.lastRunAt = Date.now()
  saveState(state)
}
