/**
 * MiroFish Predictor — orchestrates the full prediction pipeline.
 * Runs every 4 hours: fetch context → generate personas → simulate → extract signals.
 */

import * as fs from 'fs'
import { generatePersonas } from './persona-bank'
import { fetchMarketContext } from './market-feeder'
import { runSimulation, type SwarmPrediction } from './simulation-runner'
import { createSignal } from '../orchestrator/signal-bus'
import { getMultiplier } from '../orchestrator/confidence-tracker'
import { sendTelegram } from '../orchestrator/telegram-sender'
import { CONFIG } from '../config'
import pino from 'pino'

const log = pino({ name: 'mirofish' })
const PREDICTIONS_DIR = './reports'

export async function runMirofishCycle(): Promise<SwarmPrediction[]> {
  log.info('MiroFish prediction cycle starting')

  // 1. Fetch live market context
  const context = await fetchMarketContext()
  log.info(
    { symbols: Object.keys(context.symbols).length, news: context.news.recentCount },
    'Market context loaded',
  )

  // 2. Generate 100 personas
  const personas = generatePersonas()
  log.info({ count: personas.length }, 'Personas generated')

  // 3. Run 3-round simulation
  const predictions = runSimulation(personas, context, 3)

  // 4. Process predictions into signals
  for (const pred of predictions) {
    // Save prediction report
    const reportFile = `${PREDICTIONS_DIR}/mirofish_${pred.symbol}_${Date.now()}.json`
    fs.writeFileSync(reportFile, JSON.stringify(pred, null, 2))

    // Create signals for high-confidence predictions
    if (pred.confidence >= CONFIG.signalThresholds.logOnly) {
      if (pred.spacingSuggestion !== 'hold') {
        createSignal(
          {
            source: 'mirofish',
            confidence: pred.confidence,
            type: 'spacing_suggestion',
            ttlHours: 4,
            payload: {
              symbol: pred.symbol,
              currentSpacing: 0, // relay will read current from El Pesos
              suggestedSpacing: pred.spacingDelta,
              reason: pred.reasoning,
            },
            reasoning: `MiroFish swarm (${pred.consensusPct.toFixed(0)}% ${pred.direction}): ${pred.reasoning}`,
          },
          getMultiplier(),
        )
      }

      if (pred.direction !== 'neutral' && pred.confidence > 0.55) {
        createSignal(
          {
            source: 'mirofish',
            confidence: pred.confidence,
            type: 'regime_prediction',
            ttlHours: 4,
            payload: {
              symbol: pred.symbol,
              predictedRegime: pred.regimePrediction,
              currentRegime: 'unknown',
              consensusPct: pred.consensusPct,
              contrariaDissent: pred.contrarianDissent,
            },
            reasoning: `MiroFish ${pred.direction} prediction: ${pred.reasoning}`,
          },
          getMultiplier(),
        )
      }
    }
  }

  // 5. Send summary
  const summaryLines = predictions.map((p) =>
    `${p.symbol}: ${p.direction} (${(p.confidence * 100).toFixed(0)}%, ${p.consensusPct.toFixed(0)}% consensus, ${p.contrarianDissent.toFixed(0)}% dissent)`,
  )

  await sendTelegram(
    `🐟 *MiroFish Prediction*\n\n${summaryLines.join('\n')}`,
  )

  log.info({ predictions: predictions.length }, 'MiroFish cycle complete')
  return predictions
}

// Cleanup old prediction reports (keep 7 days)
export function cleanupReports(): void {
  try {
    const files = fs.readdirSync(PREDICTIONS_DIR).filter((f) => f.startsWith('mirofish_'))
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000

    for (const file of files) {
      const filepath = `${PREDICTIONS_DIR}/${file}`
      const stat = fs.statSync(filepath)
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filepath)
      }
    }
  } catch { /* ignore */ }
}
