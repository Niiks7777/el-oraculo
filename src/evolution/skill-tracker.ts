/**
 * Skill Evolution Tracker
 * Tracks which analysis patterns produce revenue vs noise.
 * Creates, promotes, and deprecates micro-skills over time.
 */

import * as fs from 'fs'
import pino from 'pino'

const log = pino({ name: 'evolution' })
const STATE_FILE = './evolution-state.json'

export interface MicroSkill {
  id: string
  name: string
  source: 'autoresearch' | 'mirofish' | 'pattern_analyzer'
  description: string
  createdAt: number
  signalsProduced: number
  signalsApplied: number
  signalsReverted: number
  totalRevenue: number
  avgConfidence: number
  status: 'active' | 'promoted' | 'deprecated'
  lastUsedAt: number
}

interface EvolutionState {
  skills: MicroSkill[]
  totalSignalsTracked: number
  totalRevenueAttributed: number
  lastEvolution: number
}

function loadState(): EvolutionState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
  } catch {
    return {
      skills: [],
      totalSignalsTracked: 0,
      totalRevenueAttributed: 0,
      lastEvolution: 0,
    }
  }
}

function saveState(state: EvolutionState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

export function registerSkill(
  name: string,
  source: MicroSkill['source'],
  description: string,
): MicroSkill {
  const state = loadState()
  const existing = state.skills.find((s) => s.name === name)
  if (existing) return existing

  const skill: MicroSkill = {
    id: `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    source,
    description,
    createdAt: Date.now(),
    signalsProduced: 0,
    signalsApplied: 0,
    signalsReverted: 0,
    totalRevenue: 0,
    avgConfidence: 0,
    status: 'active',
    lastUsedAt: Date.now(),
  }

  state.skills.push(skill)
  saveState(state)
  log.info({ name, source }, 'New micro-skill registered')
  return skill
}

export function recordSignalOutcome(
  skillName: string,
  applied: boolean,
  reverted: boolean,
  revenue: number,
  confidence: number,
): void {
  const state = loadState()
  const skill = state.skills.find((s) => s.name === skillName)
  if (!skill) return

  skill.signalsProduced++
  if (applied) skill.signalsApplied++
  if (reverted) skill.signalsReverted++
  skill.totalRevenue += revenue
  skill.avgConfidence =
    (skill.avgConfidence * (skill.signalsProduced - 1) + confidence) /
    skill.signalsProduced
  skill.lastUsedAt = Date.now()

  state.totalSignalsTracked++
  state.totalRevenueAttributed += revenue

  saveState(state)
}

export function evolveSkills(): { promoted: string[]; deprecated: string[] } {
  const state = loadState()
  const promoted: string[] = []
  const deprecated: string[] = []

  for (const skill of state.skills) {
    if (skill.status !== 'active') continue
    if (skill.signalsProduced < 5) continue // need enough data

    const revertRate =
      skill.signalsApplied > 0
        ? skill.signalsReverted / skill.signalsApplied
        : 0
    const revenuePerSignal =
      skill.signalsApplied > 0
        ? skill.totalRevenue / skill.signalsApplied
        : 0

    // Promote: high revenue, low revert rate
    if (revenuePerSignal > 0.5 && revertRate < 0.2 && skill.signalsApplied >= 5) {
      skill.status = 'promoted'
      promoted.push(skill.name)
      log.info(
        { name: skill.name, revenue: skill.totalRevenue, revertRate },
        'Skill PROMOTED',
      )
    }

    // Deprecate: negative revenue or high revert rate
    if (
      (revenuePerSignal < -0.1 && skill.signalsApplied >= 3) ||
      (revertRate > 0.5 && skill.signalsApplied >= 5)
    ) {
      skill.status = 'deprecated'
      deprecated.push(skill.name)
      log.info(
        { name: skill.name, revenue: skill.totalRevenue, revertRate },
        'Skill DEPRECATED',
      )
    }

    // Deprecate stale skills (no use in 14 days)
    const staleDays = (Date.now() - skill.lastUsedAt) / (24 * 60 * 60 * 1000)
    if (staleDays > 14 && skill.signalsProduced < 3) {
      skill.status = 'deprecated'
      deprecated.push(skill.name)
    }
  }

  state.lastEvolution = Date.now()
  saveState(state)
  return { promoted, deprecated }
}

export function getEvolutionReport(): {
  active: MicroSkill[]
  promoted: MicroSkill[]
  deprecated: MicroSkill[]
  totalRevenue: number
  topSkill: MicroSkill | null
} {
  const state = loadState()
  const active = state.skills.filter((s) => s.status === 'active')
  const promoted = state.skills.filter((s) => s.status === 'promoted')
  const deprecated = state.skills.filter((s) => s.status === 'deprecated')

  const sorted = [...active, ...promoted].sort(
    (a, b) => b.totalRevenue - a.totalRevenue,
  )

  return {
    active,
    promoted,
    deprecated,
    totalRevenue: state.totalRevenueAttributed,
    topSkill: sorted[0] ?? null,
  }
}

// Bootstrap default micro-skills
export function bootstrapDefaultSkills(): void {
  registerSkill('spacing_optimizer', 'autoresearch', 'Optimizes grid spacing via backtest loop')
  registerSkill('allocation_optimizer', 'autoresearch', 'Optimizes per-pair allocation ratios')
  registerSkill('adx_tuner', 'autoresearch', 'Tunes ADX guard thresholds')
  registerSkill('swarm_regime_predictor', 'mirofish', 'Predicts regime changes via 100-persona swarm')
  registerSkill('swarm_spacing_advisor', 'mirofish', 'Suggests spacing changes from swarm consensus')
  registerSkill('pattern_mean_reversion', 'pattern_analyzer', 'Identifies mean-reversion strength from 30-day history')
  registerSkill('pattern_volatility_regime', 'pattern_analyzer', 'Classifies volatility regimes from ATR analysis')
  registerSkill('pattern_tod_optimizer', 'pattern_analyzer', 'Optimizes time-of-day spacing multipliers')
}
