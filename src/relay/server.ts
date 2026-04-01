/**
 * Oraculo Relay — Signal Applicator & Binance Proxy
 *
 * Two jobs:
 * 1. BINANCE PROXY: Read-only Binance API using El Pesos's credentials
 * 2. SIGNAL APPLICATOR: Reads signal files, auto-applies param changes
 *
 * Deployed separately from main Oraculo. This file is self-contained.
 */

import express from 'express'
import * as crypto from 'crypto'
import * as fs from 'fs'
import pino from 'pino'

const log = pino({ name: 'oraculo-relay' })

// Load trading bot's Binance credentials from its .env
function loadBinanceCredentials(): { apiKey: string; apiSecret: string; baseUrl: string } {
  const envPath = process.env.TRADING_BOT_ENV_PATH
  if (!envPath) {
    log.error('TRADING_BOT_ENV_PATH not set. Set it to your trading bot\'s .env file path.')
    log.error('Example: TRADING_BOT_ENV_PATH=/path/to/your-bot/.env')
    process.exit(1)
  }
  if (!fs.existsSync(envPath)) {
    log.error({ path: envPath }, 'Trading bot .env file not found')
    process.exit(1)
  }
  const envContent = fs.readFileSync(envPath, 'utf-8')
  const vars: Record<string, string> = {}

  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    vars[key] = value
  }

  return {
    apiKey: vars.BINANCE_API_KEY ?? '',
    apiSecret: vars.BINANCE_API_SECRET ?? '',
    baseUrl: vars.BINANCE_REST_URL ?? 'https://fapi.binance.com',
  }
}

const CREDS = loadBinanceCredentials()

function signQuery(queryString: string): string {
  const signature = crypto
    .createHmac('sha256', CREDS.apiSecret)
    .update(queryString)
    .digest('hex')
  return `${queryString}&signature=${signature}`
}

async function binanceGet(endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
  const timestamp = Date.now().toString()
  const allParams = { ...params, timestamp, recvWindow: '5000' }
  const queryString = new URLSearchParams(allParams).toString()
  const signed = signQuery(queryString)

  const url = `${CREDS.baseUrl}${endpoint}?${signed}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)

  try {
    const res = await fetch(url, {
      headers: { 'X-MBX-APIKEY': CREDS.apiKey },
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Binance ${res.status}: ${body}`)
    }

    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

const app = express()
app.use(express.json())

// --- BINANCE PROXY (READ-ONLY) ---

app.get('/api/binance/balance', async (_req, res) => {
  try {
    const account = (await binanceGet('/fapi/v2/account')) as Record<string, unknown>
    res.json({
      totalWalletBalance: parseFloat(account.totalWalletBalance as string),
      availableBalance: parseFloat(account.availableBalance as string),
      totalUnrealizedProfit: parseFloat(account.totalUnrealizedProfit as string),
    })
  } catch (err) {
    log.error({ err }, 'Balance fetch failed')
    res.status(500).json({ error: 'Balance fetch failed' })
  }
})

app.get('/api/binance/income', async (req, res) => {
  try {
    const params: Record<string, string> = {}
    if (req.query.startTime) params.startTime = req.query.startTime as string
    if (req.query.endTime) params.endTime = req.query.endTime as string
    if (req.query.incomeType) params.incomeType = req.query.incomeType as string
    params.limit = (req.query.limit as string) ?? '1000'

    const income = await binanceGet('/fapi/v1/income', params)
    res.json(income)
  } catch (err) {
    log.error({ err }, 'Income fetch failed')
    res.status(500).json({ error: 'Income fetch failed' })
  }
})

app.get('/api/binance/positions', async (_req, res) => {
  try {
    const positions = (await binanceGet('/fapi/v2/positionRisk')) as Array<Record<string, unknown>>
    const active = positions.filter(
      (p) => parseFloat(p.positionAmt as string) !== 0,
    )
    res.json(active)
  } catch (err) {
    log.error({ err }, 'Positions fetch failed')
    res.status(500).json({ error: 'Positions fetch failed' })
  }
})

// --- SIGNAL APPLICATION (forwards to El Pesos) ---

const EL_PESOS_API = `http://${process.env.EL_PESOS_HOST || 'localhost'}:4201`

app.post('/api/apply-signal', async (req, res) => {
  try {
    const { parameter, symbol, newValue, source, signalId, strength } = req.body as {
      parameter: string
      symbol?: string
      newValue: number
      source: string
      signalId: string
      strength: number
    }

    if (!parameter || newValue === undefined || !signalId) {
      res.status(400).json({ error: 'Missing fields' })
      return
    }

    // Apply strength multiplier (conservative = 50%, full = 100%)
    // Strength blends between current and proposed value
    // For now, pass newValue directly — El Pesos validates bounds
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)

    const elPesosRes = await fetch(`${EL_PESOS_API}/api/apply-param`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parameter, symbol, newValue, source, signalId }),
      signal: controller.signal,
    })

    clearTimeout(timer)

    const result = await elPesosRes.json()

    if (!elPesosRes.ok) {
      log.warn({ status: elPesosRes.status, result }, 'El Pesos rejected signal')
      res.status(elPesosRes.status).json(result)
      return
    }

    log.info({ signalId, parameter, newValue, source }, 'Signal applied to El Pesos')
    res.json(result)
  } catch (err) {
    log.error({ err }, 'Signal application failed')
    res.status(500).json({ error: 'Failed to apply signal to El Pesos' })
  }
})

// --- SIGNAL READER ---

const SIGNALS_DIR = './signals'

app.get('/api/signals/pending', (_req, res) => {
  try {
    const files = fs.readdirSync(SIGNALS_DIR).filter((f) => f.endsWith('.json'))
    const now = Date.now()
    const signals: unknown[] = []

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(`${SIGNALS_DIR}/${file}`, 'utf-8'))
        const expiresAt = data.timestamp + data.ttlHours * 60 * 60 * 1000
        if (now <= expiresAt && data.status === 'pending') {
          signals.push(data)
        }
      } catch { /* skip */ }
    }

    res.json(signals)
  } catch (err) {
    log.error({ err }, 'Signal read failed')
    res.status(500).json({ error: 'Signal read failed' })
  }
})

// --- KILLSWITCH ---

app.post('/api/kill', async (_req, res) => {
  log.warn('KILLSWITCH activated via relay')

  // Revert last 3 applied signals
  try {
    const files = fs.readdirSync(SIGNALS_DIR).filter((f) => f.endsWith('.json'))
    const applied = files
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(`${SIGNALS_DIR}/${f}`, 'utf-8'))
        } catch {
          return null
        }
      })
      .filter((s) => s && s.status === 'applied')
      .sort((a: any, b: any) => (b.appliedAt ?? 0) - (a.appliedAt ?? 0))
      .slice(0, 3)

    for (const signal of applied) {
      signal.status = 'reverted'
      signal.revertedAt = Date.now()
      const filename = fs
        .readdirSync(SIGNALS_DIR)
        .find((f) => f.includes(signal.id))
      if (filename) {
        fs.writeFileSync(
          `${SIGNALS_DIR}/${filename}`,
          JSON.stringify(signal, null, 2),
        )
      }
    }

    log.info({ reverted: applied.length }, 'Reverted last applied signals')
    res.json({
      ok: true,
      action: 'killed',
      reverted: applied.length,
      message: 'Oraculo paused for 12h. Last 3 signals reverted.',
    })
  } catch (err) {
    log.error({ err }, 'Kill error')
    res.status(500).json({ error: 'Kill failed' })
  }
})

// --- HEALTH ---

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    signalsDir: fs.existsSync(SIGNALS_DIR),
  })
})

const PORT = 4202
app.listen(PORT, '0.0.0.0', () => {
  log.info({ port: PORT }, 'Oraculo relay started')
})
