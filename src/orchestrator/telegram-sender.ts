import { CONFIG } from '../config'
import pino from 'pino'

const log = pino({ name: 'telegram' })

export async function sendTelegram(message: string): Promise<void> {
  const { botToken, chatId } = CONFIG.telegram

  if (!botToken || !chatId) {
    log.debug({ message }, 'Telegram not configured — skipping')
    return
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🔮 El Oraculo\n\n${message}`,
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!res.ok) {
      log.warn({ status: res.status }, 'Telegram send failed')
    }
  } catch (err) {
    log.error({ err }, 'Telegram send error')
  }
}

export async function sendSignalNotification(
  source: string,
  confidence: number,
  action: string,
  reasoning: string,
): Promise<void> {
  const confidenceBar = '█'.repeat(Math.round(confidence * 10)) +
    '░'.repeat(10 - Math.round(confidence * 10))

  const msg = [
    `📡 *Signal Applied*`,
    `Source: ${source}`,
    `Confidence: ${(confidence * 100).toFixed(1)}% [${confidenceBar}]`,
    `Action: ${action}`,
    `Reason: ${reasoning}`,
  ].join('\n')

  await sendTelegram(msg)
}

export async function sendDailyReport(report: {
  date: string
  pnl: number
  trades: number
  winRate: number
  signalsApplied: number
  signalsReverted: number
  goalTarget: number
  goalActual: number
  confidenceMultiplier: number
  topModule: string
}): Promise<void> {
  const pnlSign = report.pnl >= 0 ? '+' : ''
  const goalStatus = report.goalActual >= report.goalTarget ? '✅' : '⚠️'

  const msg = [
    `📊 *Daily Report — ${report.date}*`,
    ``,
    `P&L: ${pnlSign}$${report.pnl.toFixed(2)}`,
    `Trades: ${report.trades} (${(report.winRate * 100).toFixed(0)}% win)`,
    `Signals: ${report.signalsApplied} applied, ${report.signalsReverted} reverted`,
    ``,
    `${goalStatus} Goal: $${report.goalActual.toFixed(2)} / $${report.goalTarget.toFixed(2)}`,
    `Confidence: ${report.confidenceMultiplier.toFixed(2)}x`,
    `Top module: ${report.topModule}`,
  ].join('\n')

  await sendTelegram(msg)
}
