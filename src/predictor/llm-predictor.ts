/**
 * LLM Predictor — replaces fake persona swarm with actual Nemotron inference.
 *
 * Makes 1 LLM call per symbol via OpenRouter (nvidia/nemotron-3-super-120b:free).
 * The LLM gets full market context and returns a structured prediction.
 * This is REAL AI inference, not if/else rules dressed as a swarm.
 */

import { CONFIG } from '../config'
import { fetchMarketContext, type MarketContext, type SymbolContext } from './market-feeder'
import { createSignal } from '../orchestrator/signal-bus'
import { getMultiplier } from '../orchestrator/confidence-tracker'
import { sendTelegram } from '../orchestrator/telegram-sender'
import * as fs from 'fs'
import pino from 'pino'

const log = pino({ name: 'llm-predictor' })
const REPORTS_DIR = './reports'

export interface LLMPrediction {
  symbol: string
  direction: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  regimePrediction: string
  spacingSuggestion: 'tighten' | 'widen' | 'hold'
  reasoning: string
  rawResponse: string
}

async function callNemotron(prompt: string): Promise<string> {
  const apiKey = CONFIG.openRouter.apiKey
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://el-oraculo.local',
      },
      body: JSON.stringify({
        model: CONFIG.openRouter.mirofishModel,
        messages: [
          {
            role: 'system',
            content: `You are a quantitative crypto trading analyst for a grid mean-reversion bot trading Binance USDT-M perpetual futures. You analyze technical indicators, market regime, and sentiment to predict short-term (4-hour) market direction and recommend grid spacing adjustments.

You MUST respond in this EXACT JSON format:
{
  "direction": "bullish" | "bearish" | "neutral",
  "confidence": 0.0 to 1.0,
  "regime": "trending_up" | "trending_down" | "ranging" | "volatile" | "mean_reverting",
  "spacing": "tighten" | "widen" | "hold",
  "reasoning": "1-2 sentence explanation"
}

Rules:
- confidence 0.5 = no edge, 0.7+ = moderate conviction, 0.85 = max (never higher)
- "tighten" when mean-reverting/ranging (RSI 40-60, low ADX, high wick ratio)
- "widen" when volatile/trending (high ADX, BB squeeze breakout, news events)
- "hold" when no clear signal
- Be conservative. If indicators conflict, say neutral with 0.5 confidence.
- Consider funding rate direction for directional bias.`,
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1000,
        temperature: 0.3,
      }),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`OpenRouter ${res.status}: ${err}`)
    }

    const data = await res.json() as Record<string, unknown>

    const choices = data.choices as Array<{
      message: { content: string | null; reasoning: string | null }
    }> | undefined
    const msg = choices?.[0]?.message
    // Nemotron is a reasoning model: content may be null, reasoning has the chain-of-thought
    const content = msg?.content ?? ''
    const reasoning = msg?.reasoning ?? ''

    // If content is empty but reasoning has JSON, extract from reasoning
    if (!content && reasoning) {
      log.info('Using reasoning field (Nemotron reasoning model)')
      return reasoning
    }

    if (!content) {
      log.warn({ data: JSON.stringify(data).slice(0, 500) }, 'Empty LLM response')
    }

    return content
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

function buildPrompt(symbol: string, sym: SymbolContext, ctx: MarketContext): string {
  return `Analyze ${symbol} for the next 4 hours. Current market state:

INDICATORS:
- Price: $${sym.price.toFixed(2)}
- RSI(14): ${sym.rsi.toFixed(1)}
- MACD Histogram: ${sym.macdHist.toFixed(4)}
- ADX(14): ${sym.adx.toFixed(1)}
- Supertrend Direction: ${sym.supertrendDir > 0 ? 'UP' : sym.supertrendDir < 0 ? 'DOWN' : 'FLAT'}
- Bollinger Band Squeeze: ${sym.bbSqueeze ? 'YES (compression → breakout imminent)' : 'NO'}
- Hurst Exponent: ${sym.hurst.toFixed(3)} (>0.5 = trending, <0.5 = mean-reverting)
- Permutation Entropy: ${sym.permEntropy.toFixed(3)} (higher = more random)

FUNDING & REGIME:
- Funding Rate: ${(sym.fundingRate * 100).toFixed(4)}% per 8h
- Funding Bias: ${sym.fundingBias}
- Current Regime: ${sym.regime}

SENTIMENT:
- Recent news count (6h): ${ctx.news.recentCount}
- Average sentiment: ${ctx.news.avgSentiment.toFixed(2)} (-1 to +1)
- High-impact events: ${ctx.news.highImpactCount}
- Top headline: "${ctx.news.topHeadline}"

PORTFOLIO:
- Balance: $${ctx.macro.totalBalance.toFixed(2)}
- Unrealized P&L: $${ctx.macro.unrealizedPnl.toFixed(2)}

This is a GRID MEAN-REVERSION bot. It profits from range-bound conditions. Predict whether to tighten spacing (more fills in range), widen spacing (protect during trends/volatility), or hold current.

Respond with JSON only.`
}

function parseResponse(raw: string): Partial<LLMPrediction> {
  try {
    // Extract JSON from response (may have markdown wrapping)
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return {}
    const parsed = JSON.parse(jsonMatch[0])
    return {
      direction: parsed.direction ?? 'neutral',
      confidence: Math.min(parseFloat(parsed.confidence) || 0.5, 0.85),
      regimePrediction: parsed.regime ?? 'ranging',
      spacingSuggestion: parsed.spacing ?? 'hold',
      reasoning: parsed.reasoning ?? '',
    }
  } catch {
    return {}
  }
}

export async function runLLMPredictionCycle(): Promise<LLMPrediction[]> {
  log.info('LLM prediction cycle starting (Nemotron)')

  const ctx = await fetchMarketContext()
  const predictions: LLMPrediction[] = []

  for (const [symbol, sym] of Object.entries(ctx.symbols)) {
    try {
      const prompt = buildPrompt(symbol, sym, ctx)
      log.info({ symbol }, 'Calling Nemotron...')

      const raw = await callNemotron(prompt)
      const parsed = parseResponse(raw)

      const prediction: LLMPrediction = {
        symbol,
        direction: (parsed.direction as LLMPrediction['direction']) ?? 'neutral',
        confidence: parsed.confidence ?? 0.5,
        regimePrediction: parsed.regimePrediction ?? 'ranging',
        spacingSuggestion: (parsed.spacingSuggestion as LLMPrediction['spacingSuggestion']) ?? 'hold',
        reasoning: parsed.reasoning ?? 'No reasoning provided',
        rawResponse: raw,
      }

      predictions.push(prediction)

      log.info({
        symbol,
        direction: prediction.direction,
        confidence: prediction.confidence.toFixed(3),
        spacing: prediction.spacingSuggestion,
        regime: prediction.regimePrediction,
      }, 'LLM prediction')

      // Save report
      const reportFile = `${REPORTS_DIR}/llm_${symbol}_${Date.now()}.json`
      fs.writeFileSync(reportFile, JSON.stringify(prediction, null, 2))

      // Generate signals for actionable predictions
      // Send ABSOLUTE spacing values, not deltas. Current default is 0.0035.
      // Tighten = 0.0030, Widen = 0.0042 (bounded by grid engine's 0.0025-0.006)
      if (prediction.confidence >= 0.45 && prediction.spacingSuggestion !== 'hold') {
        const currentSpacing = 0.0035  // base default
        const newSpacing = prediction.spacingSuggestion === 'tighten'
          ? Math.max(0.0028, currentSpacing - 0.0005)
          : Math.min(0.0050, currentSpacing + 0.0007)

        createSignal(
          {
            source: 'mirofish',
            confidence: prediction.confidence,
            type: 'param_change',
            ttlHours: 4,
            payload: {
              parameter: 'spacing',
              symbol,
              oldValue: currentSpacing,
              newValue: newSpacing,
              backtestScore: 0,
              baselineScore: 0,
            },
            reasoning: `Nemotron LLM (${prediction.direction}, ${(prediction.confidence * 100).toFixed(0)}%): ${prediction.reasoning}`,
          },
          getMultiplier(),
        )
      }

      // Small delay between calls to be respectful to free API
      await new Promise((r) => setTimeout(r, 2000))
    } catch (err) {
      log.error({ symbol, err }, 'LLM prediction failed')
      predictions.push({
        symbol,
        direction: 'neutral',
        confidence: 0.5,
        regimePrediction: 'unknown',
        spacingSuggestion: 'hold',
        reasoning: `LLM call failed: ${err}`,
        rawResponse: '',
      })
    }
  }

  // Send summary
  const lines = predictions.map(
    (p) => `${p.symbol}: ${p.direction} (${(p.confidence * 100).toFixed(0)}%) — ${p.spacingSuggestion} — ${p.reasoning.slice(0, 80)}`,
  )
  await sendTelegram(`🤖 Nemotron Prediction\n\n${lines.join('\n')}`)

  log.info({ count: predictions.length }, 'LLM prediction cycle complete')
  return predictions
}
