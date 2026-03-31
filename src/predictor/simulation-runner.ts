/**
 * MiroFish Simulation Runner
 * Runs personas through market context in 3 rounds of interaction.
 * Extracts consensus signals with anti-herd corrections.
 */

import type { Persona, PersonaArchetype } from './persona-bank'
import type { MarketContext, SymbolContext } from './market-feeder'
import pino from 'pino'

const log = pino({ name: 'mirofish-sim' })

export interface PersonaVote {
  personaId: string
  archetype: PersonaArchetype
  symbol: string
  direction: 'long' | 'short' | 'neutral'
  confidence: number
  reasoning: string
}

export interface SwarmPrediction {
  symbol: string
  direction: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  consensusPct: number
  contrarianDissent: number
  regimePrediction: string
  spacingSuggestion: 'tighten' | 'widen' | 'hold'
  spacingDelta: number
  reasoning: string
  voteBreakdown: {
    long: number
    short: number
    neutral: number
  }
  archetypeBreakdown: Record<PersonaArchetype, { long: number; short: number; neutral: number }>
}

const CONFIDENCE_CEILING = 0.85

export function runSimulation(
  personas: Persona[],
  context: MarketContext,
  rounds = 3,
): SwarmPrediction[] {
  const symbols = Object.keys(context.symbols)
  const predictions: SwarmPrediction[] = []

  for (const symbol of symbols) {
    const symContext = context.symbols[symbol]

    // Round 1: Independent votes
    let votes = personas.map((p) => castVote(p, symContext, symbol, context))

    // Round 2: Influence — personas adjust based on round 1 consensus
    const r1Consensus = computeConsensus(votes)
    votes = personas.map((p, i) => {
      const original = votes[i]
      return applyInfluence(p, original, r1Consensus)
    })

    // Round 3: Final adjustment with contrarian pushback
    const r2Consensus = computeConsensus(votes)
    votes = personas.map((p, i) => {
      const current = votes[i]
      if (p.archetype === 'contrarian') {
        return pushBack(current, r2Consensus)
      }
      return current
    })

    // Extract prediction with anti-herd corrections
    const prediction = extractPrediction(votes, symbol, symContext)
    predictions.push(prediction)

    log.info({
      symbol,
      direction: prediction.direction,
      confidence: prediction.confidence.toFixed(3),
      consensus: prediction.consensusPct.toFixed(1) + '%',
      dissent: prediction.contrarianDissent.toFixed(1) + '%',
    }, 'Swarm prediction')
  }

  return predictions
}

function castVote(
  persona: Persona,
  sym: SymbolContext,
  symbol: string,
  ctx: MarketContext,
): PersonaVote {
  let direction: PersonaVote['direction'] = 'neutral'
  let confidence = 0.5
  let reasoning = ''

  switch (persona.archetype) {
    case 'momentum': {
      if (sym.adx > 25 && sym.supertrendDir > 0) {
        direction = 'long'
        confidence = 0.5 + (sym.adx - 25) / 50
        reasoning = `ADX ${sym.adx.toFixed(0)} + supertrend up`
      } else if (sym.adx > 25 && sym.supertrendDir < 0) {
        direction = 'short'
        confidence = 0.5 + (sym.adx - 25) / 50
        reasoning = `ADX ${sym.adx.toFixed(0)} + supertrend down`
      } else {
        reasoning = 'No clear trend'
      }
      break
    }
    case 'mean_reversion': {
      if (sym.rsi < 30) {
        direction = 'long'
        confidence = 0.5 + (30 - sym.rsi) / 60
        reasoning = `RSI oversold ${sym.rsi.toFixed(0)}`
      } else if (sym.rsi > 70) {
        direction = 'short'
        confidence = 0.5 + (sym.rsi - 70) / 60
        reasoning = `RSI overbought ${sym.rsi.toFixed(0)}`
      } else {
        direction = 'neutral'
        confidence = 0.6
        reasoning = `RSI neutral ${sym.rsi.toFixed(0)}, grid-friendly`
      }
      break
    }
    case 'whale_watcher': {
      // React to volume/OI signals (simplified — full version uses whale alerts API)
      if (sym.bbSqueeze) {
        direction = sym.macdHist > 0 ? 'long' : 'short'
        confidence = 0.6
        reasoning = `BB squeeze, breakout imminent, MACD ${sym.macdHist > 0 ? 'bullish' : 'bearish'}`
      } else {
        reasoning = 'No whale signals detected'
      }
      break
    }
    case 'news_reactive': {
      const sentiment = ctx.news.avgSentiment
      if (sentiment > 0.3) {
        direction = 'long'
        confidence = 0.5 + sentiment * 0.3
        reasoning = `Positive sentiment ${sentiment.toFixed(2)}`
      } else if (sentiment < -0.3) {
        direction = 'short'
        confidence = 0.5 + Math.abs(sentiment) * 0.3
        reasoning = `Negative sentiment ${sentiment.toFixed(2)}`
      } else {
        reasoning = `Neutral sentiment ${sentiment.toFixed(2)}`
      }
      if (ctx.news.highImpactCount > 0) {
        confidence = Math.min(confidence + 0.1, 0.85)
        reasoning += ` (${ctx.news.highImpactCount} high-impact events)`
      }
      break
    }
    case 'contrarian': {
      // Will be adjusted in round 3 — for now, lean against any extreme
      if (sym.rsi > 65) {
        direction = 'short'
        confidence = 0.5 + (sym.rsi - 65) / 70
        reasoning = `Contrarian: RSI ${sym.rsi.toFixed(0)} too extended`
      } else if (sym.rsi < 35) {
        direction = 'long'
        confidence = 0.5 + (35 - sym.rsi) / 70
        reasoning = `Contrarian: RSI ${sym.rsi.toFixed(0)} oversold bounce`
      } else {
        reasoning = 'No extreme to fade'
      }
      break
    }
    case 'noise': {
      // Random vote for calibration
      const r = Math.random()
      direction = r < 0.33 ? 'long' : r < 0.66 ? 'short' : 'neutral'
      confidence = 0.3 + Math.random() * 0.3
      reasoning = 'Random noise agent'
      break
    }
    case 'funding_arb': {
      const rate = sym.fundingRate
      if (rate > 0.0001) {
        direction = 'short' // collect funding
        confidence = 0.5 + Math.min(rate * 1000, 0.3)
        reasoning = `Funding positive ${(rate * 100).toFixed(4)}%, short collects`
      } else if (rate < -0.0001) {
        direction = 'long'
        confidence = 0.5 + Math.min(Math.abs(rate) * 1000, 0.3)
        reasoning = `Funding negative ${(rate * 100).toFixed(4)}%, long collects`
      } else {
        reasoning = `Funding neutral ${(rate * 100).toFixed(4)}%`
      }
      break
    }
  }

  // Apply persona bias
  if (persona.bias !== 'neutral' && direction === 'neutral') {
    if (Math.random() < 0.3) {
      direction = persona.bias
      confidence *= 0.8
      reasoning += ` (${persona.bias} bias nudge)`
    }
  }

  return {
    personaId: persona.id,
    archetype: persona.archetype,
    symbol,
    direction,
    confidence: Math.min(confidence, CONFIDENCE_CEILING),
    reasoning,
  }
}

function computeConsensus(votes: PersonaVote[]): { majority: string; pct: number } {
  const counts = { long: 0, short: 0, neutral: 0 }
  for (const v of votes) counts[v.direction]++
  const total = votes.length
  const majority = Object.entries(counts).reduce((a, b) => (b[1] > a[1] ? b : a))[0]
  return { majority, pct: (counts[majority as keyof typeof counts] / total) * 100 }
}

function applyInfluence(
  persona: Persona,
  vote: PersonaVote,
  consensus: { majority: string; pct: number },
): PersonaVote {
  // Contrarians resist influence
  if (persona.archetype === 'contrarian') return vote
  // Noise agents don't care
  if (persona.archetype === 'noise') return vote

  // If consensus is strong and persona disagrees, moderate slightly
  if (consensus.pct > 60 && vote.direction !== consensus.majority) {
    const influence = (consensus.pct - 60) / 100 * persona.riskTolerance
    if (Math.random() < influence) {
      return {
        ...vote,
        direction: consensus.majority as PersonaVote['direction'],
        confidence: vote.confidence * 0.7,
        reasoning: vote.reasoning + ` (influenced by ${consensus.pct.toFixed(0)}% consensus)`,
      }
    }
  }

  return vote
}

function pushBack(
  vote: PersonaVote,
  consensus: { majority: string; pct: number },
): PersonaVote {
  // Contrarians oppose strong consensus
  if (consensus.pct > 55) {
    const opposite = consensus.majority === 'long' ? 'short' : consensus.majority === 'short' ? 'long' : 'neutral'
    return {
      ...vote,
      direction: opposite as PersonaVote['direction'],
      confidence: Math.min(vote.confidence + 0.1, CONFIDENCE_CEILING),
      reasoning: `Contrarian pushback: ${consensus.pct.toFixed(0)}% ${consensus.majority} → going ${opposite}`,
    }
  }
  return vote
}

function extractPrediction(
  votes: PersonaVote[],
  symbol: string,
  sym: SymbolContext,
): SwarmPrediction {
  const counts = { long: 0, short: 0, neutral: 0 }
  const confidences = { long: [] as number[], short: [] as number[], neutral: [] as number[] }
  const archetypeBreakdown: Record<PersonaArchetype, { long: number; short: number; neutral: number }> = {} as any

  for (const v of votes) {
    counts[v.direction]++
    confidences[v.direction].push(v.confidence)

    if (!archetypeBreakdown[v.archetype]) {
      archetypeBreakdown[v.archetype] = { long: 0, short: 0, neutral: 0 }
    }
    archetypeBreakdown[v.archetype][v.direction]++
  }

  const total = votes.length
  const majority = Object.entries(counts).reduce((a, b) => (b[1] > a[1] ? b : a))
  const majorityDir = majority[0] as 'long' | 'short' | 'neutral'
  const consensusPct = (majority[1] / total) * 100

  // Contrarian dissent
  const contrarianVotes = votes.filter((v) => v.archetype === 'contrarian')
  const contrarianDissent = contrarianVotes.length > 0
    ? (contrarianVotes.filter((v) => v.direction !== majorityDir).length / contrarianVotes.length) * 100
    : 0

  // Average confidence of majority
  const majorityConfidences = confidences[majorityDir]
  const avgConfidence = majorityConfidences.length > 0
    ? majorityConfidences.reduce((s, c) => s + c, 0) / majorityConfidences.length
    : 0.5

  // Anti-herd: reduce confidence if consensus too high with low dissent
  let finalConfidence = avgConfidence
  if (consensusPct > 80 && contrarianDissent < 20) {
    finalConfidence *= 0.8 // Suspiciously unanimous
  }
  finalConfidence = Math.min(finalConfidence, CONFIDENCE_CEILING)

  // Regime prediction based on votes
  const regimePrediction = sym.adx > 30 ? 'trending' : sym.hurst > 0.55 ? 'mean_reverting' : 'ranging'

  // Spacing suggestion
  let spacingSuggestion: SwarmPrediction['spacingSuggestion'] = 'hold'
  let spacingDelta = 0
  if (consensusPct > 70 && majorityDir !== 'neutral') {
    spacingSuggestion = 'widen'
    spacingDelta = 0.05
  } else if (counts.neutral > total * 0.5) {
    spacingSuggestion = 'tighten'
    spacingDelta = -0.05
  }

  // Build reasoning
  const topReasons = votes
    .filter((v) => v.direction === majorityDir && v.confidence > 0.6)
    .slice(0, 3)
    .map((v) => v.reasoning)

  const direction = majorityDir === 'long' ? 'bullish' : majorityDir === 'short' ? 'bearish' : 'neutral'

  return {
    symbol,
    direction,
    confidence: finalConfidence,
    consensusPct,
    contrarianDissent,
    regimePrediction,
    spacingSuggestion,
    spacingDelta,
    reasoning: `${consensusPct.toFixed(0)}% ${direction} consensus. ${topReasons.join('; ')}`,
    voteBreakdown: counts,
    archetypeBreakdown,
  }
}
