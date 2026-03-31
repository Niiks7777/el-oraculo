/**
 * Watchdog — MONITOR ONLY
 *
 * NEVER restarts El Pesos. NEVER kills positions. NEVER touches the trading bot.
 * Only monitors and sends Telegram alerts. The user holds the killswitch.
 *
 * El Pesos has its own systemd Restart=always (45s). It doesn't need Oraculo
 * to restart it. Any automated restart/kill risks interrupting active trades.
 */

import { CONFIG } from '../config'
import { healthCheck } from '../collector/api-reader'
import { sendTelegram } from './telegram-sender'
import type { WatchdogState } from '../types'
import pino from 'pino'

const log = pino({ name: 'watchdog' })

const state: WatchdogState = {
  consecutiveFails: 0,
  lastSuccessAt: Date.now(),
  lastFailAt: 0,
  lastRestartAttemptAt: 0,
}

export async function runWatchdogCheck(): Promise<void> {
  const alive = await healthCheck()

  if (alive) {
    if (state.consecutiveFails >= 5) {
      await sendTelegram('✅ El Pesos is back online after ' + state.consecutiveFails + ' fails')
    }
    state.consecutiveFails = 0
    state.lastSuccessAt = Date.now()
    return
  }

  state.consecutiveFails++
  state.lastFailAt = Date.now()

  log.warn({ consecutiveFails: state.consecutiveFails }, 'El Pesos health check failed')

  // Alert only — NEVER take action on the trading bot
  if (state.consecutiveFails === 5) {
    await sendTelegram('⚠️ El Pesos unresponsive — 5 consecutive fails (2.5 min). Monitoring only.')
  }

  if (state.consecutiveFails === 20) {
    await sendTelegram('🔴 El Pesos down for 10 minutes (20 fails). Check CT 100 manually.')
  }

  // After 20 fails, only alert every 5 minutes (not every 30s)
  if (state.consecutiveFails > 20 && state.consecutiveFails % 10 === 0) {
    await sendTelegram('🔴 El Pesos still down — ' + state.consecutiveFails + ' fails (' + Math.floor(state.consecutiveFails * 30 / 60) + ' min)')
  }
}

export function getWatchdogState(): WatchdogState {
  return { ...state }
}
