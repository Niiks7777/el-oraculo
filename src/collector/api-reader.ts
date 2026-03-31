import { CONFIG } from '../config'
import type {
  ElPesosStatus,
  DailyPnl,
  PerformanceSnapshot,
  Indicators,
  BinanceIncome,
  BinanceBalance,
} from '../types'

const API = CONFIG.elPesos.apiUrl
const RELAY = CONFIG.elPesos.relayUrl

async function fetchJson<T>(url: string, timeoutMs = 5000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${url}`)
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export async function getStatus(): Promise<ElPesosStatus> {
  return fetchJson<ElPesosStatus>(`${API}/api/status`)
}

export async function getIndicators(): Promise<Indicators> {
  return fetchJson<Indicators>(`${API}/api/indicators`)
}

export async function getDailyPnl(days = 14): Promise<DailyPnl[]> {
  return fetchJson<DailyPnl[]>(`${API}/api/daily-pnl?days=${days}`)
}

export async function getSnapshots(symbol: string, hours = 48): Promise<PerformanceSnapshot[]> {
  return fetchJson<PerformanceSnapshot[]>(`${API}/api/snapshots/${symbol}?hours=${hours}`)
}

export async function getBinanceStats(): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(`${API}/api/binance-stats`)
}

export async function getRegime(symbol: string): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(`${API}/api/regime/${symbol}`)
}

export async function getFunding(): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(`${API}/api/funding`)
}

export async function getRisk(): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(`${API}/api/risk`)
}

export async function getNewsEvents(hours = 24): Promise<unknown[]> {
  return fetchJson<unknown[]>(`${API}/api/news-events?hours=${hours}`)
}

export async function getNewsImpact(hours = 48): Promise<unknown[]> {
  return fetchJson<unknown[]>(`${API}/api/news-impact?hours=${hours}`)
}

export async function getEquityHistory(days = 30): Promise<unknown[]> {
  return fetchJson<unknown[]>(`${API}/api/equity-history?days=${days}`)
}

export async function getLearning(): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(`${API}/api/learning`)
}

export async function getGoals(): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(`${API}/api/goals`)
}

export async function getWhaleAlerts(): Promise<unknown[]> {
  return fetchJson<unknown[]>(`${API}/api/whale-alerts`)
}

// --- Binance proxy via relay on CT 100 ---

export async function getBinanceIncome(
  startTime?: number,
  endTime?: number,
  incomeType?: string,
): Promise<BinanceIncome[]> {
  const params = new URLSearchParams()
  if (startTime) params.set('startTime', String(startTime))
  if (endTime) params.set('endTime', String(endTime))
  if (incomeType) params.set('incomeType', incomeType)
  return fetchJson<BinanceIncome[]>(`${RELAY}/api/binance/income?${params}`)
}

export async function getBinanceBalance(): Promise<BinanceBalance> {
  return fetchJson<BinanceBalance>(`${RELAY}/api/binance/balance`)
}

export async function getBinancePositions(): Promise<unknown[]> {
  return fetchJson<unknown[]>(`${RELAY}/api/binance/positions`)
}

export async function healthCheck(): Promise<boolean> {
  try {
    await fetchJson<unknown>(`${API}/api/status`, 2000)
    return true
  } catch {
    return false
  }
}
