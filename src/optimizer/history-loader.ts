/**
 * Loads historical 1m candles from Binance public API (no auth needed).
 * Caches to ./backtest-data/ for reuse.
 */

import * as fs from 'fs'
import * as path from 'path'
import { CONFIG } from '../config'
import type { Candle } from './backtest-engine'
import pino from 'pino'

const log = pino({ name: 'history-loader' })
const CACHE_DIR = CONFIG.paths.backtestData
const BINANCE_PUBLIC = 'https://fapi.binance.com'

export async function loadCandles(
  symbol: string,
  days: number,
  interval = '1m',
): Promise<Candle[]> {
  const cacheFile = path.join(
    CACHE_DIR,
    `${symbol}_${interval}_${days}d_${todayStr()}.json`,
  )

  // Check cache
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as Candle[]
      if (cached.length > 0) {
        log.info({ symbol, days, cached: cached.length }, 'Using cached candles')
        return cached
      }
    } catch { /* reload */ }
  }

  // Fetch from Binance
  const endTime = Date.now()
  const startTime = endTime - days * 24 * 60 * 60 * 1000
  const allCandles: Candle[] = []
  let fetchStart = startTime

  log.info({ symbol, days, interval }, 'Fetching candles from Binance')

  while (fetchStart < endTime) {
    const url = `${BINANCE_PUBLIC}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${fetchStart}&limit=1500`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)

    try {
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)

      if (!res.ok) {
        log.error({ status: res.status }, 'Binance klines fetch failed')
        break
      }

      const data = (await res.json()) as number[][]

      if (data.length === 0) break

      for (const k of data) {
        allCandles.push({
          openTime: k[0] as number,
          open: parseFloat(k[1] as unknown as string),
          high: parseFloat(k[2] as unknown as string),
          low: parseFloat(k[3] as unknown as string),
          close: parseFloat(k[4] as unknown as string),
          volume: parseFloat(k[5] as unknown as string),
        })
      }

      fetchStart = (data[data.length - 1][0] as number) + 1

      // Rate limit: 2 requests per second max
      await sleep(500)
    } catch (err) {
      clearTimeout(timer)
      log.error({ err }, 'Candle fetch error')
      break
    }
  }

  // Cache
  if (allCandles.length > 0) {
    fs.writeFileSync(cacheFile, JSON.stringify(allCandles))
    log.info({ symbol, candles: allCandles.length }, 'Candles cached')
  }

  // Cleanup old cache files (keep last 7 days)
  cleanupCache()

  return allCandles
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cleanupCache(): void {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'))
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000

    for (const file of files) {
      const filepath = path.join(CACHE_DIR, file)
      const stat = fs.statSync(filepath)
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filepath)
      }
    }
  } catch { /* ignore */ }
}
