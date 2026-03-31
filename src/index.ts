import { startScheduler, stopScheduler } from './orchestrator/scheduler'
import { startDashboard } from './orchestrator/dashboard'
import { initializeBaseline } from './orchestrator/goal-system'
import { bootstrapDefaultSkills } from './evolution/skill-tracker'
import { sendTelegram } from './orchestrator/telegram-sender'
import pino from 'pino'

const log = pino({ name: 'oraculo' })

async function main(): Promise<void> {
  log.info('🔮 El Oraculo starting...')

  // Start dashboard API
  startDashboard()

  // Bootstrap default micro-skills for evolution tracking
  bootstrapDefaultSkills()

  // Initialize baseline goals from Binance
  try {
    await initializeBaseline()
  } catch (err) {
    log.warn({ err }, 'Could not initialize baseline — relay may not be ready yet')
  }

  // Start all schedulers
  startScheduler()

  await sendTelegram('🔮 El Oraculo is online. Watchdog active. Autonomous mode.')

  log.info('El Oraculo fully operational')
}

// Graceful shutdown
function shutdown(signal: string): void {
  log.info({ signal }, 'Shutting down...')
  stopScheduler()
  sendTelegram(`🔮 El Oraculo shutting down (${signal})`).finally(() => {
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => {
  log.error({ err }, 'Unhandled rejection')
})

main().catch((err) => {
  log.fatal({ err }, 'Fatal startup error')
  process.exit(1)
})
