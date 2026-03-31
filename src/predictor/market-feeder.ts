/**
 * Market Feeder — pulls live context from El Pesos API
 * and structures it for MiroFish persona consumption.
 */

import * as api from '../collector/api-reader'
import pino from 'pino'

const log = pino({ name: 'market-feeder' })

export interface MarketContext {
  timestamp: number
  symbols: Record<string, SymbolContext>
  macro: MacroContext
  news: NewsContext
}

export interface SymbolContext {
  price: number
  rsi: number
  macdHist: number
  adx: number
  supertrendDir: number
  bbSqueeze: boolean
  hurst: number
  permEntropy: number
  fundingRate: number
  fundingBias: string
  regime: string
  recentPnl: number
  spacing: number
}

export interface MacroContext {
  fearGreed: number
  fearGreedLabel: string
  btcPrice: number
  btcChange24h: number
  totalBalance: number
  unrealizedPnl: number
}

export interface NewsContext {
  recentCount: number
  avgSentiment: number
  highImpactCount: number
  topHeadline: string
}

export async function fetchMarketContext(): Promise<MarketContext> {
  try {
    const [status, indicators, funding, market, newsEvents] = await Promise.all([
      api.getStatus(),
      api.getIndicators(),
      api.getFunding(),
      api.getBinanceStats().catch(() => ({})),
      api.getNewsEvents(6).catch(() => []),
    ])

    const symbols: Record<string, SymbolContext> = {}
    const statusAny = status as unknown as Record<string, unknown>
    const regimeStates = (statusAny.regimeStates ?? {}) as Record<string, unknown>
    const fundingBiases = (statusAny.fundingBiases ?? {}) as Record<string, Record<string, unknown>>

    for (const [sym, ind] of Object.entries(indicators)) {
      const indAny = ind as Record<string, number | boolean | string>
      const fundSym = (funding as Record<string, Record<string, unknown>>)[sym] ?? {}
      const regSym = regimeStates[sym] as Record<string, unknown> | undefined

      symbols[sym] = {
        price: (indAny.close as number) ?? 0,
        rsi: (indAny.rsi as number) ?? 50,
        macdHist: (indAny.macdHist as number) ?? 0,
        adx: (indAny.adx as number) ?? 20,
        supertrendDir: (indAny.supertrendDir as number) ?? 0,
        bbSqueeze: (indAny.bbSqueeze as boolean) ?? false,
        hurst: (indAny.hurst as number) ?? 0.5,
        permEntropy: (indAny.permEntropy as number) ?? 1,
        fundingRate: parseFloat(String(fundSym.rate ?? 0)),
        fundingBias: String(fundSym.bias ?? 'neutral'),
        regime: String(regSym?.label ?? 'unknown'),
        recentPnl: 0,
        spacing: 0,
      }
    }

    const news = newsEvents as Array<Record<string, unknown>>
    const avgSentiment = news.length > 0
      ? news.reduce((s, n) => s + (parseFloat(String(n.sentiment_score ?? 0))), 0) / news.length
      : 0
    const highImpact = news.filter(n => (n.impact_estimate as number) >= 4).length

    return {
      timestamp: Date.now(),
      symbols,
      macro: {
        fearGreed: 0,
        fearGreedLabel: 'neutral',
        btcPrice: 0,
        btcChange24h: 0,
        totalBalance: (statusAny.futuresBalance as number) ?? 0,
        unrealizedPnl: (statusAny.totalUnrealizedPnl as number) ?? 0,
      },
      news: {
        recentCount: news.length,
        avgSentiment,
        highImpactCount: highImpact,
        topHeadline: news.length > 0 ? String(news[0].title ?? '') : 'No recent news',
      },
    }
  } catch (err) {
    log.error({ err }, 'Failed to fetch market context')
    throw err
  }
}
