/**
 * HMM Signal Generator
 * Runs hourly: loads latest candle data, computes HMM state probabilities,
 * and generates spacing signals when regime is confidently "normal" (tighten)
 * or "spike" (widen). Feeds into the existing signal pipeline → relay → El Pesos.
 */

import { loadCandles } from './history-loader'
import { loadHMMModel, forwardFilter, type HMMModel, type HMMState } from './hmm-filter'
import { createSignal } from '../orchestrator/signal-bus'
import { getMultiplier } from '../orchestrator/confidence-tracker'
import { sendTelegram } from '../orchestrator/telegram-sender'
import pino from 'pino'

const log = pino({ name: 'hmm-signals' })

const PAIRS = ['ETHUSDT', 'SOLUSDT', 'TAOUSDT']
const BASE_SPACING: Record<string, number> = {
  ETHUSDT: 0.0035,
  SOLUSDT: 0.0035,
  TAOUSDT: 0.0035,
}

// HMM-derived spacing adjustments
const NORMAL_SPACING_MULT = 1.0   // Normal state: use base spacing
const SPIKE_SPACING_MULT = 1.5    // Spike state: widen 50%
const CONFIDENCE_THRESHOLD = 0.70 // Only act when HMM is confident

export async function runHMMSignalCycle(): Promise<void> {
  log.info('HMM signal cycle starting')

  for (const pair of PAIRS) {
    try {
      const model = loadHMMModel(pair)

      // Load recent 2 days of candles (enough for hourly aggregation)
      const candles = await loadCandles(pair, 2)
      if (candles.length < 120) {
        log.warn({ pair, candles: candles.length }, 'Not enough candles for HMM')
        continue
      }

      // Aggregate to hourly closes
      const hourlyCloses: number[] = []
      let lastHour = -1
      for (const c of candles) {
        const hour = Math.floor(c.openTime / 3600000)
        if (hour !== lastHour) {
          if (lastHour !== -1) hourlyCloses.push(c.close)
          lastHour = hour
        }
      }
      hourlyCloses.push(candles[candles.length - 1].close)

      if (hourlyCloses.length < 10) continue

      // Compute log returns
      const returns: number[] = []
      for (let i = 1; i < hourlyCloses.length; i++) {
        returns.push(Math.log(hourlyCloses[i] / hourlyCloses[i - 1]))
      }

      // Run forward filter
      const states = forwardFilter(model, returns)
      const current = states[states.length - 1]

      log.info({
        pair,
        state: current.state === 0 ? 'normal' : 'spike',
        confidence: current.confidence.toFixed(3),
        probs: current.probabilities.map(p => p.toFixed(3)),
      }, 'HMM state')

      // Generate signal if confident
      if (current.confidence < CONFIDENCE_THRESHOLD) {
        log.debug({ pair }, 'HMM uncertain — no signal')
        continue
      }

      const baseSpacing = BASE_SPACING[pair] ?? 0.0035
      const mult = current.state === 0 ? NORMAL_SPACING_MULT : SPIKE_SPACING_MULT
      const suggestedSpacing = Math.max(0.0025, Math.min(0.006, baseSpacing * mult))

      // Only signal if spacing would change meaningfully (>5% difference)
      const currentSpacing = baseSpacing // TODO: read current from El Pesos API
      const changePct = Math.abs(suggestedSpacing - currentSpacing) / currentSpacing
      if (changePct < 0.05) {
        log.debug({ pair, changePct: changePct.toFixed(3) }, 'Change too small — no signal')
        continue
      }

      createSignal(
        {
          source: 'autoresearch', // uses autoresearch source for param_change type
          confidence: current.confidence * 0.9, // slight discount for model uncertainty
          type: 'param_change',
          ttlHours: 2, // short TTL — HMM states change hourly
          payload: {
            parameter: 'spacing',
            symbol: pair,
            oldValue: currentSpacing,
            newValue: suggestedSpacing,
            backtestScore: 0,
            baselineScore: 0,
          },
          reasoning: `HMM ${current.state === 0 ? 'normal' : 'spike'} state (${(current.confidence * 100).toFixed(0)}% confidence) → spacing ${current.state === 0 ? 'tighten' : 'widen'} to ${(suggestedSpacing * 100).toFixed(3)}%`,
        },
        getMultiplier(),
      )

      log.info({ pair, spacing: suggestedSpacing, state: current.state === 0 ? 'normal' : 'spike' }, 'HMM signal created')
    } catch (err) {
      log.error({ pair, err }, 'HMM signal generation failed')
    }
  }

  log.info('HMM signal cycle complete')
}

/**
 * Retrain HMM models using latest 30-day data.
 * Called weekly by the scheduler.
 */
export async function retrainHMMModels(): Promise<void> {
  log.info('HMM retrain starting')

  try {
    const { execSync } = require('child_process')
    execSync('python3 ./src/optimizer/hmm-trainer.py', {
      timeout: 120000,
      cwd: '/shared/oraculo',
    })
    log.info('HMM retrain complete')
    await sendTelegram('🧬 HMM models retrained on latest 30-day data')
  } catch (err) {
    log.error({ err }, 'HMM retrain failed')
  }
}
