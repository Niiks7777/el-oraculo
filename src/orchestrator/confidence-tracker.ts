import * as fs from 'fs'
import { CONFIG } from '../config'

const STATE_FILE = './confidence-state.json'

interface ConfidenceState {
  multiplier: number
  consecutiveWins: number
  consecutiveMisses: number
  pausedUntil: number | null
  lastUpdated: number
  history: Array<{
    timestamp: number
    outcome: 'win' | 'miss'
    multiplierBefore: number
    multiplierAfter: number
  }>
}

function loadState(): ConfidenceState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
  } catch {
    return {
      multiplier: CONFIG.confidence.baseMultiplier,
      consecutiveWins: 0,
      consecutiveMisses: 0,
      pausedUntil: null,
      lastUpdated: Date.now(),
      history: [],
    }
  }
}

function saveState(state: ConfidenceState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

export function getMultiplier(): number {
  const state = loadState()

  if (state.pausedUntil && Date.now() < state.pausedUntil) {
    return 0 // paused — no signals applied
  }

  return state.multiplier
}

export function isPaused(): boolean {
  const state = loadState()
  return state.pausedUntil !== null && Date.now() < state.pausedUntil
}

export function recordOutcome(outcome: 'win' | 'miss'): void {
  const state = loadState()
  const before = state.multiplier

  if (outcome === 'win') {
    state.consecutiveWins++
    state.consecutiveMisses = 0
    state.multiplier = Math.min(
      state.multiplier + CONFIG.confidence.winIncrement,
      CONFIG.confidence.maxMultiplier,
    )
  } else {
    state.consecutiveMisses++
    state.consecutiveWins = 0
    state.multiplier = Math.max(
      state.multiplier - CONFIG.confidence.lossDecrement,
      CONFIG.confidence.minMultiplier,
    )

    if (state.consecutiveMisses >= CONFIG.confidence.consecutiveMissReset) {
      state.multiplier = CONFIG.confidence.baseMultiplier
      state.pausedUntil =
        Date.now() + CONFIG.confidence.pauseHoursOnReset * 60 * 60 * 1000
      state.consecutiveMisses = 0
    }
  }

  state.history = [
    {
      timestamp: Date.now(),
      outcome,
      multiplierBefore: before,
      multiplierAfter: state.multiplier,
    },
    ...state.history.slice(0, 99),
  ]
  state.lastUpdated = Date.now()
  saveState(state)
}

export function getState(): ConfidenceState {
  return loadState()
}

export function resetMultiplier(): void {
  const state = loadState()
  state.multiplier = CONFIG.confidence.baseMultiplier
  state.consecutiveWins = 0
  state.consecutiveMisses = 0
  state.pausedUntil = null
  state.lastUpdated = Date.now()
  saveState(state)
}
