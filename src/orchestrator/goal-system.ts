import * as fs from 'fs'
import { getBinanceIncome } from '../collector/api-reader'
import { sendTelegram } from './telegram-sender'
import { getState as getConfidenceState } from './confidence-tracker'
import type { WeeklyGoal, BinanceIncome } from '../types'
import pino from 'pino'

const log = pino({ name: 'goal-system' })
const GOALS_FILE = './goals-state.json'

interface GoalsState {
  currentGoal: WeeklyGoal | null
  history: WeeklyGoal[]
  baselineDailyPnl: number | null
  lastEvaluation: number
}

function loadGoals(): GoalsState {
  try {
    return JSON.parse(fs.readFileSync(GOALS_FILE, 'utf-8'))
  } catch {
    return {
      currentGoal: null,
      history: [],
      baselineDailyPnl: null,
      lastEvaluation: 0,
    }
  }
}

function saveGoals(state: GoalsState): void {
  fs.writeFileSync(GOALS_FILE, JSON.stringify(state, null, 2))
}

function getWeekStart(): string {
  const now = new Date()
  const day = now.getUTCDay()
  const diff = now.getUTCDate() - day
  const weekStart = new Date(now)
  weekStart.setUTCDate(diff)
  weekStart.setUTCHours(0, 0, 0, 0)
  return weekStart.toISOString().split('T')[0]
}

async function getWeeklyPnl(weekStartMs: number): Promise<number> {
  const income = await getBinanceIncome(weekStartMs, Date.now(), 'REALIZED_PNL')
  return income.reduce((sum, i) => sum + parseFloat(i.income), 0)
}

export async function initializeBaseline(): Promise<void> {
  const state = loadGoals()
  if (state.baselineDailyPnl !== null) return

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const income = await getBinanceIncome(sevenDaysAgo, Date.now(), 'REALIZED_PNL')
  const totalPnl = income.reduce((sum, i) => sum + parseFloat(i.income), 0)
  const dailyAvg = totalPnl / 7

  state.baselineDailyPnl = dailyAvg
  state.currentGoal = {
    weekStart: getWeekStart(),
    target: dailyAvg * 7 * 1.15, // 15% improvement
    actual: 0,
    achieved: false,
    multiplierAtWeekEnd: 1.0,
    topModule: '',
    topModuleRevenue: 0,
  }

  saveGoals(state)
  log.info(
    { dailyAvg, weeklyTarget: state.currentGoal.target },
    'Baseline established',
  )
  await sendTelegram(
    `📈 Baseline established\nAvg daily P&L: $${dailyAvg.toFixed(2)}\nWeek 1 target: $${state.currentGoal.target.toFixed(2)}`,
  )
}

export async function evaluateWeeklyGoal(): Promise<void> {
  const state = loadGoals()
  if (!state.currentGoal) {
    await initializeBaseline()
    return
  }

  const weekStart = getWeekStart()
  if (state.currentGoal.weekStart === weekStart) {
    // Same week — update actual
    const weekStartMs = new Date(weekStart + 'T00:00:00Z').getTime()
    state.currentGoal.actual = await getWeeklyPnl(weekStartMs)
    saveGoals(state)
    return
  }

  // New week — evaluate previous
  const prevGoal = state.currentGoal
  const confidenceState = getConfidenceState()
  prevGoal.multiplierAtWeekEnd = confidenceState.multiplier
  prevGoal.achieved = prevGoal.actual >= prevGoal.target

  // Archive
  state.history = [prevGoal, ...state.history.slice(0, 51)]

  // Set new goal
  const missPercent =
    prevGoal.target > 0
      ? (prevGoal.target - prevGoal.actual) / prevGoal.target
      : 0

  let newTarget: number

  if (prevGoal.achieved) {
    // Exceeded — compound upward 10%
    newTarget = prevGoal.actual * 1.10
    log.info(
      { prevActual: prevGoal.actual, newTarget },
      'Goal exceeded — compounding up',
    )
    await sendTelegram(
      `🚀 *Weekly Goal EXCEEDED*\nActual: $${prevGoal.actual.toFixed(2)} vs Target: $${prevGoal.target.toFixed(2)}\nNew target: $${newTarget.toFixed(2)} (+10%)`,
    )
  } else if (missPercent < 0.2) {
    // Missed by <20% — keep same
    newTarget = prevGoal.target
    log.info(
      { missPercent, target: prevGoal.target },
      'Goal missed slightly — keeping target',
    )
    await sendTelegram(
      `⚠️ *Weekly Goal missed by ${(missPercent * 100).toFixed(0)}%*\nActual: $${prevGoal.actual.toFixed(2)} vs Target: $${prevGoal.target.toFixed(2)}\nKeeping same target. Triggering extra autoresearch cycles.`,
    )
  } else {
    // Missed hard — reset lower
    newTarget = Math.max(prevGoal.actual * 1.05, 1)
    log.warn(
      { missPercent, actual: prevGoal.actual, newTarget },
      'Goal missed hard — resetting',
    )
    await sendTelegram(
      `🔴 *Weekly Goal missed by ${(missPercent * 100).toFixed(0)}%*\nActual: $${prevGoal.actual.toFixed(2)} vs Target: $${prevGoal.target.toFixed(2)}\nResetting target to $${newTarget.toFixed(2)}. Dampening confidence 15%.`,
    )
  }

  state.currentGoal = {
    weekStart,
    target: newTarget,
    actual: 0,
    achieved: false,
    multiplierAtWeekEnd: confidenceState.multiplier,
    topModule: '',
    topModuleRevenue: 0,
  }

  state.lastEvaluation = Date.now()
  saveGoals(state)
}

export function getCurrentGoal(): WeeklyGoal | null {
  return loadGoals().currentGoal
}

export function getGoalHistory(): WeeklyGoal[] {
  return loadGoals().history
}
