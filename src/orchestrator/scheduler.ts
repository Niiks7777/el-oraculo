import { CONFIG } from '../config'
import { runWatchdogCheck, getWatchdogState } from './watchdog'
import { readPendingSignals, cleanupExpiredSignals } from './signal-bus'
import { resolveConflicts } from './conflict-resolver'
import { getMultiplier, isPaused } from './confidence-tracker'
import { evaluateWeeklyGoal, getCurrentGoal } from './goal-system'
import { sendTelegram, sendSignalNotification } from './telegram-sender'
import { runAutoresearchCycle } from '../optimizer/loop-runner'
import { runLLMPredictionCycle } from '../predictor/llm-predictor'
import { runHMMSignalCycle, retrainHMMModels } from '../optimizer/hmm-signal-generator'
import pino from 'pino'

const log = pino({ name: 'scheduler' })

let watchdogTimer: NodeJS.Timeout | null = null
let collectorTimer: NodeJS.Timeout | null = null
let signalProcessorTimer: NodeJS.Timeout | null = null
let goalTimer: NodeJS.Timeout | null = null
let running = false

export function startScheduler(): void {
  if (running) return
  running = true
  log.info('Oraculo scheduler starting')

  // Watchdog — every 30s
  watchdogTimer = setInterval(async () => {
    try {
      await runWatchdogCheck()
    } catch (err) {
      log.error({ err }, 'Watchdog check error')
    }
  }, CONFIG.schedules.watchdogIntervalMs)

  // Signal processor — every 60s
  signalProcessorTimer = setInterval(async () => {
    try {
      await processSignals()
    } catch (err) {
      log.error({ err }, 'Signal processing error')
    }
  }, 60_000)

  // Cleanup expired signals — every 10 min
  setInterval(() => {
    const cleaned = cleanupExpiredSignals()
    if (cleaned > 0) {
      log.info({ cleaned }, 'Cleaned expired signals')
    }
  }, 10 * 60 * 1000)

  // Goal evaluation — check every hour, evaluate on Sunday
  goalTimer = setInterval(async () => {
    try {
      const now = new Date()
      if (
        now.getUTCDay() === CONFIG.schedules.goalEvalDay &&
        now.getUTCHours() === 0
      ) {
        await evaluateWeeklyGoal()
      }
    } catch (err) {
      log.error({ err }, 'Goal evaluation error')
    }
  }, 60 * 60 * 1000)

  // Autoresearch — every 12h
  const autoresearchLoop = async () => {
    while (running) {
      try {
        log.info('Starting autoresearch cycle')
        await runAutoresearchCycle()
      } catch (err) {
        log.error({ err }, 'Autoresearch cycle error')
      }
      // Sleep 12h
      await new Promise((r) => setTimeout(r, CONFIG.schedules.autoresearchIntervalMs))
    }
  }
  // Kick off after 5 min warmup
  setTimeout(() => { autoresearchLoop().catch(() => {}) }, 5 * 60 * 1000)

  // LLM Predictor (Nemotron) — every 4h
  const llmLoop = async () => {
    while (running) {
      try {
        log.info('Starting LLM prediction cycle (Nemotron)')
        await runLLMPredictionCycle()
      } catch (err) {
        log.error({ err }, 'LLM prediction cycle error')
      }
      await new Promise((r) => setTimeout(r, CONFIG.schedules.mirofishIntervalMs))
    }
  }
  setTimeout(() => { llmLoop().catch(() => {}) }, 2 * 60 * 1000)

  // HMM regime signals — every 1h
  const hmmLoop = async () => {
    while (running) {
      try {
        await runHMMSignalCycle()
      } catch (err) {
        log.error({ err }, 'HMM signal cycle error')
      }
      await new Promise((r) => setTimeout(r, 60 * 60 * 1000)) // 1h
    }
  }
  setTimeout(() => { hmmLoop().catch(() => {}) }, 3 * 60 * 1000) // start after 3 min

  // HMM retrain — weekly (Sunday 02:00 UTC)
  setInterval(async () => {
    const now = new Date()
    if (now.getUTCDay() === 0 && now.getUTCHours() === 2) {
      try {
        await retrainHMMModels()
      } catch (err) {
        log.error({ err }, 'HMM retrain error')
      }
    }
  }, 60 * 60 * 1000)

  log.info('All schedulers started (autoresearch 5m, LLM 2m, HMM 3m)')
}

export function stopScheduler(): void {
  running = false
  if (watchdogTimer) clearInterval(watchdogTimer)
  if (collectorTimer) clearInterval(collectorTimer)
  if (signalProcessorTimer) clearInterval(signalProcessorTimer)
  if (goalTimer) clearInterval(goalTimer)
  log.info('Scheduler stopped')
}

async function processSignals(): Promise<void> {
  if (isPaused()) {
    log.debug('Confidence paused — skipping signal processing')
    return
  }

  const pending = readPendingSignals()
  if (pending.length === 0) return

  const resolved = resolveConflicts(pending)
  const multiplier = getMultiplier()

  for (const { winner, conflicts, confidenceReduction } of resolved) {
    const effective = winner.adjustedConfidence * (1 - confidenceReduction)

    if (effective < CONFIG.signalThresholds.logOnly) {
      log.debug(
        { signalId: winner.id, confidence: effective },
        'Signal below threshold — log only',
      )
      continue
    }

    const action = describeSignal(winner)

    if (effective < CONFIG.signalThresholds.conservative) {
      // Apply 50% of the change
      log.info(
        { signalId: winner.id, confidence: effective, action },
        'Conservative apply (50%)',
      )
      await applySignal(winner, 0.5)
      await sendSignalNotification(
        winner.source,
        effective,
        `${action} (50% conservative)`,
        winner.reasoning,
      )
    } else if (effective < CONFIG.signalThresholds.full) {
      // Apply full change
      log.info(
        { signalId: winner.id, confidence: effective, action },
        'Full apply',
      )
      await applySignal(winner, 1.0)
      await sendSignalNotification(
        winner.source,
        effective,
        action,
        winner.reasoning,
      )
    } else {
      // High confidence — apply and widen exploration
      log.info(
        { signalId: winner.id, confidence: effective, action },
        'High confidence apply + widen',
      )
      await applySignal(winner, 1.0)
      await sendSignalNotification(
        winner.source,
        effective,
        `${action} (high confidence — widening exploration)`,
        winner.reasoning,
      )
    }

    if (conflicts.length > 0) {
      log.info(
        {
          winnerId: winner.id,
          conflictIds: conflicts.map((c) => c.id),
          reduction: confidenceReduction,
        },
        'Conflict resolved',
      )
    }
  }
}

async function applySignal(
  signal: import('../types').Signal,
  strength: number,
): Promise<void> {
  const payload = signal.payload as unknown as Record<string, unknown>
  let parameter = (payload.parameter as string) ?? signal.type
  const symbol = payload.symbol as string | undefined
  const newValue = payload.newValue as number | undefined

  // Map autoresearch param names to El Pesos learned-state keys
  const PARAM_MAP: Record<string, string> = {
    baseSpacingPct: 'spacing',
    atrSpacingMult: 'atr_mult',
    ethAllocation: 'allocation',
    solAllocation: 'allocation',
    taoAllocation: 'allocation',
  }
  if (PARAM_MAP[parameter]) parameter = PARAM_MAP[parameter]

  if (!parameter || newValue === undefined) {
    log.warn({ signalId: signal.id }, 'Signal has no applicable parameter — skipping')
    return
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)

    const res = await fetch(`${CONFIG.elPesos.relayUrl}/api/apply-signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parameter,
        symbol,
        newValue,
        source: signal.source,
        signalId: signal.id,
        strength,
      }),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (res.ok) {
      const result = await res.json()
      const { updateSignalStatus } = await import('./signal-bus')
      updateSignalStatus(signal.id, 'applied', { appliedAt: Date.now() })
      log.info({ signalId: signal.id, parameter, newValue, result }, 'Signal APPLIED to El Pesos')
    } else {
      const err = await res.text()
      log.warn({ signalId: signal.id, status: res.status, err }, 'El Pesos rejected signal')
    }
  } catch (err) {
    log.error({ signalId: signal.id, err }, 'Failed to apply signal via relay')
  }
}

function describeSignal(signal: import('../types').Signal): string {
  const payload = signal.payload as unknown as Record<string, unknown>

  switch (signal.type) {
    case 'param_change':
      return `${payload.parameter}: ${payload.oldValue} → ${payload.newValue}`
    case 'spacing_suggestion':
      return `${payload.symbol} spacing: ${payload.currentSpacing} → ${payload.suggestedSpacing}`
    case 'regime_prediction':
      return `${payload.symbol} regime: ${payload.currentRegime} → ${payload.predictedRegime}`
    case 'allocation_change':
      return `${payload.parameter}: ${payload.oldValue} → ${payload.newValue}`
    default:
      return `${signal.type}: ${signal.reasoning}`
  }
}

export function getSchedulerStatus(): Record<string, unknown> {
  return {
    running,
    watchdog: getWatchdogState(),
    confidenceMultiplier: getMultiplier(),
    confidencePaused: isPaused(),
    currentGoal: getCurrentGoal(),
    pendingSignals: readPendingSignals().length,
  }
}
