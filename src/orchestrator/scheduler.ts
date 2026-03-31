import { CONFIG } from '../config'
import { runWatchdogCheck, getWatchdogState } from './watchdog'
import { readPendingSignals, cleanupExpiredSignals } from './signal-bus'
import { resolveConflicts } from './conflict-resolver'
import { getMultiplier, isPaused } from './confidence-tracker'
import { sendTelegram, sendSignalNotification } from './telegram-sender'
import pino from 'pino'

const log = pino({ name: 'scheduler' })

// Pro modules — loaded dynamically (stubs in free tier)
let runAutoresearchCycle: (() => Promise<void>) | null = null
let runLLMPredictionCycle: (() => Promise<unknown>) | null = null
let runHMMSignalCycle: (() => Promise<void>) | null = null
let retrainHMMModels: (() => Promise<void>) | null = null
let evaluateWeeklyGoal: (() => Promise<void>) | null = null
let getCurrentGoal: (() => unknown) | null = null

try { const m = require('../optimizer/loop-runner'); runAutoresearchCycle = m.runAutoresearchCycle } catch { /* Pro feature */ }
try { const m = require('../predictor/llm-predictor'); runLLMPredictionCycle = m.runLLMPredictionCycle } catch { /* Pro feature */ }
try { const m = require('../optimizer/hmm-signal-generator'); runHMMSignalCycle = m.runHMMSignalCycle; retrainHMMModels = m.retrainHMMModels } catch { /* Pro feature */ }
try { const m = require('./goal-system'); evaluateWeeklyGoal = m.evaluateWeeklyGoal; getCurrentGoal = m.getCurrentGoal } catch { /* Pro feature */ }

let watchdogTimer: NodeJS.Timeout | null = null
let signalProcessorTimer: NodeJS.Timeout | null = null
let goalTimer: NodeJS.Timeout | null = null
let running = false

export function startScheduler(): void {
  if (running) return
  running = true
  log.info('Oraculo scheduler starting')

  // Watchdog — every 30s
  watchdogTimer = setInterval(async () => {
    try { await runWatchdogCheck() } catch (err) { log.error({ err }, 'Watchdog error') }
  }, CONFIG.schedules.watchdogIntervalMs)

  // Signal processor — every 60s
  signalProcessorTimer = setInterval(async () => {
    try { await processSignals() } catch (err) { log.error({ err }, 'Signal processing error') }
  }, 60_000)

  // Cleanup expired signals — every 10 min
  setInterval(() => {
    const cleaned = cleanupExpiredSignals()
    if (cleaned > 0) log.info({ cleaned }, 'Cleaned expired signals')
  }, 10 * 60 * 1000)

  // Goal evaluation — Sundays (Pro)
  if (evaluateWeeklyGoal) {
    goalTimer = setInterval(async () => {
      try {
        const now = new Date()
        if (now.getUTCDay() === CONFIG.schedules.goalEvalDay && now.getUTCHours() === 0) {
          await evaluateWeeklyGoal!()
        }
      } catch (err) { log.error({ err }, 'Goal evaluation error') }
    }, 60 * 60 * 1000)
  }

  // Autoresearch — every 12h (Pro)
  if (runAutoresearchCycle) {
    const loop = async () => {
      while (running) {
        try { await runAutoresearchCycle!() } catch (err) { log.error({ err }, 'Autoresearch error') }
        await new Promise((r) => setTimeout(r, CONFIG.schedules.autoresearchIntervalMs))
      }
    }
    setTimeout(() => { loop().catch(() => {}) }, 5 * 60 * 1000)
    log.info('Autoresearch enabled (Pro)')
  }

  // LLM Predictor — every 4h (Pro)
  if (runLLMPredictionCycle) {
    const loop = async () => {
      while (running) {
        try { await runLLMPredictionCycle!() } catch (err) { log.error({ err }, 'LLM prediction error') }
        await new Promise((r) => setTimeout(r, CONFIG.schedules.mirofishIntervalMs))
      }
    }
    setTimeout(() => { loop().catch(() => {}) }, 2 * 60 * 1000)
    log.info('LLM Predictor enabled (Pro)')
  }

  // HMM regime signals — every 1h (Pro)
  if (runHMMSignalCycle) {
    const loop = async () => {
      while (running) {
        try { await runHMMSignalCycle!() } catch (err) { log.error({ err }, 'HMM signal error') }
        await new Promise((r) => setTimeout(r, 60 * 60 * 1000))
      }
    }
    setTimeout(() => { loop().catch(() => {}) }, 3 * 60 * 1000)
    log.info('HMM Regime enabled (Pro)')

    // Retrain weekly
    if (retrainHMMModels) {
      setInterval(async () => {
        const now = new Date()
        if (now.getUTCDay() === 0 && now.getUTCHours() === 2) {
          try { await retrainHMMModels!() } catch (err) { log.error({ err }, 'HMM retrain error') }
        }
      }, 60 * 60 * 1000)
    }
  }

  const proModules = [runAutoresearchCycle, runLLMPredictionCycle, runHMMSignalCycle].filter(Boolean).length
  log.info({ proModules }, `Scheduler started (${proModules} Pro modules active)`)
}

export function stopScheduler(): void {
  running = false
  if (watchdogTimer) clearInterval(watchdogTimer)
  if (signalProcessorTimer) clearInterval(signalProcessorTimer)
  if (goalTimer) clearInterval(goalTimer)
  log.info('Scheduler stopped')
}

async function processSignals(): Promise<void> {
  if (isPaused()) return

  const pending = readPendingSignals()
  if (pending.length === 0) return

  const resolved = resolveConflicts(pending)
  const multiplier = getMultiplier()

  for (const { winner, conflicts, confidenceReduction } of resolved) {
    const effective = winner.adjustedConfidence * (1 - confidenceReduction)

    if (effective < CONFIG.signalThresholds.logOnly) continue

    const action = describeSignal(winner)

    if (effective < CONFIG.signalThresholds.conservative) {
      log.info({ signalId: winner.id, confidence: effective, action }, 'Conservative apply (50%)')
      await applySignal(winner, 0.5)
      await sendSignalNotification(winner.source, effective, `${action} (50%)`, winner.reasoning)
    } else if (effective < CONFIG.signalThresholds.full) {
      log.info({ signalId: winner.id, confidence: effective, action }, 'Full apply')
      await applySignal(winner, 1.0)
      await sendSignalNotification(winner.source, effective, action, winner.reasoning)
    } else {
      log.info({ signalId: winner.id, confidence: effective, action }, 'High confidence apply')
      await applySignal(winner, 1.0)
      await sendSignalNotification(winner.source, effective, `${action} (high confidence)`, winner.reasoning)
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

  const PARAM_MAP: Record<string, string> = {
    baseSpacingPct: 'spacing',
    atrSpacingMult: 'atr_mult',
    ethAllocation: 'allocation',
    solAllocation: 'allocation',
    taoAllocation: 'allocation',
  }
  if (PARAM_MAP[parameter]) parameter = PARAM_MAP[parameter]

  if (!parameter || newValue === undefined) {
    log.warn({ signalId: signal.id }, 'Signal has no applicable parameter')
    return
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)

    const res = await fetch(`${CONFIG.elPesos.relayUrl}/api/apply-signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parameter, symbol, newValue, source: signal.source, signalId: signal.id, strength }),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (res.ok) {
      const { updateSignalStatus } = await import('./signal-bus')
      updateSignalStatus(signal.id, 'applied', { appliedAt: Date.now() })
      log.info({ signalId: signal.id, parameter, newValue }, 'Signal APPLIED')
    } else {
      const err = await res.text()
      log.warn({ signalId: signal.id, status: res.status, err }, 'Signal rejected')
    }
  } catch (err) {
    log.error({ signalId: signal.id, err }, 'Signal apply failed')
  }
}

function describeSignal(signal: import('../types').Signal): string {
  const payload = signal.payload as unknown as Record<string, unknown>
  switch (signal.type) {
    case 'param_change': return `${payload.parameter}: ${payload.oldValue} → ${payload.newValue}`
    case 'spacing_suggestion': return `${payload.symbol} spacing: ${payload.currentSpacing} → ${payload.suggestedSpacing}`
    case 'regime_prediction': return `${payload.symbol} regime: ${payload.currentRegime} → ${payload.predictedRegime}`
    default: return `${signal.type}: ${signal.reasoning}`
  }
}

export function getSchedulerStatus(): Record<string, unknown> {
  return {
    running,
    watchdog: getWatchdogState(),
    confidenceMultiplier: getMultiplier(),
    confidencePaused: isPaused(),
    currentGoal: getCurrentGoal ? getCurrentGoal() : null,
    pendingSignals: readPendingSignals().length,
    proModules: {
      autoresearch: !!runAutoresearchCycle,
      llmPredictor: !!runLLMPredictionCycle,
      hmmRegime: !!runHMMSignalCycle,
      goalSystem: !!evaluateWeeklyGoal,
    },
  }
}
