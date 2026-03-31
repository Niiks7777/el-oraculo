import { startScheduler, stopScheduler } from './orchestrator/scheduler'
import { startDashboard } from './orchestrator/dashboard'
import { sendTelegram } from './orchestrator/telegram-sender'
import pino from 'pino'

const log = pino({ name: 'oraculo' })

async function main(): Promise<void> {
  log.info('🔮 El Oraculo starting...')

  // Start dashboard API
  startDashboard()

  // Pro modules — loaded dynamically
  try { const { bootstrapDefaultSkills } = require('./evolution/skill-tracker'); bootstrapDefaultSkills() } catch { /* Pro */ }
  try { const { initializeBaseline } = require('./orchestrator/goal-system'); await initializeBaseline() } catch { /* Pro */ }

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
