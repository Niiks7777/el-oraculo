/**
 * Trader Persona Definitions for MiroFish Swarm Predictions
 *
 * 100 personas across 7 archetypes. Each has distinct behavior
 * that shapes how they interpret market signals.
 */

export interface Persona {
  id: string
  archetype: PersonaArchetype
  name: string
  bias: 'long' | 'short' | 'neutral'
  riskTolerance: number  // 0-1
  timeHorizon: 'scalper' | 'intraday' | 'swing'
  indicators: string[]
  description: string
}

export type PersonaArchetype =
  | 'momentum'
  | 'mean_reversion'
  | 'whale_watcher'
  | 'news_reactive'
  | 'contrarian'
  | 'noise'
  | 'funding_arb'

const ARCHETYPE_CONFIG: Record<PersonaArchetype, {
  count: number
  biasDistribution: Record<string, number>
  riskRange: [number, number]
}> = {
  momentum:       { count: 15, biasDistribution: { long: 0.4, short: 0.4, neutral: 0.2 }, riskRange: [0.5, 0.9] },
  mean_reversion: { count: 20, biasDistribution: { long: 0.3, short: 0.3, neutral: 0.4 }, riskRange: [0.3, 0.7] },
  whale_watcher:  { count: 10, biasDistribution: { long: 0.3, short: 0.3, neutral: 0.4 }, riskRange: [0.4, 0.8] },
  news_reactive:  { count: 15, biasDistribution: { long: 0.3, short: 0.3, neutral: 0.4 }, riskRange: [0.5, 0.9] },
  contrarian:     { count: 15, biasDistribution: { long: 0.3, short: 0.3, neutral: 0.4 }, riskRange: [0.4, 0.8] },
  noise:          { count: 10, biasDistribution: { long: 0.33, short: 0.33, neutral: 0.34 }, riskRange: [0.1, 1.0] },
  funding_arb:    { count: 15, biasDistribution: { long: 0.2, short: 0.2, neutral: 0.6 }, riskRange: [0.2, 0.5] },
}

export function generatePersonas(): Persona[] {
  const personas: Persona[] = []
  let id = 0

  for (const [archetype, config] of Object.entries(ARCHETYPE_CONFIG)) {
    for (let i = 0; i < config.count; i++) {
      id++
      const bias = pickBias(config.biasDistribution)
      const risk = config.riskRange[0] + Math.random() * (config.riskRange[1] - config.riskRange[0])

      personas.push({
        id: `${archetype}_${id}`,
        archetype: archetype as PersonaArchetype,
        name: `${archetype.replace('_', ' ')} #${i + 1}`,
        bias,
        riskTolerance: Math.round(risk * 100) / 100,
        timeHorizon: pickTimeHorizon(archetype as PersonaArchetype),
        indicators: pickIndicators(archetype as PersonaArchetype),
        description: describePersona(archetype as PersonaArchetype, bias, risk),
      })
    }
  }

  return personas
}

function pickBias(dist: Record<string, number>): Persona['bias'] {
  const r = Math.random()
  if (r < dist.long) return 'long'
  if (r < dist.long + dist.short) return 'short'
  return 'neutral'
}

function pickTimeHorizon(archetype: PersonaArchetype): Persona['timeHorizon'] {
  const map: Record<PersonaArchetype, Persona['timeHorizon'][]> = {
    momentum: ['intraday', 'swing'],
    mean_reversion: ['scalper', 'intraday'],
    whale_watcher: ['intraday', 'swing'],
    news_reactive: ['scalper', 'intraday'],
    contrarian: ['swing', 'intraday'],
    noise: ['scalper', 'intraday', 'swing'],
    funding_arb: ['intraday', 'swing'],
  }
  const options = map[archetype]
  return options[Math.floor(Math.random() * options.length)]
}

function pickIndicators(archetype: PersonaArchetype): string[] {
  const map: Record<PersonaArchetype, string[][]> = {
    momentum: [['ADX', 'MACD', 'RSI'], ['EMA crossover', 'Supertrend'], ['Volume', 'OBV']],
    mean_reversion: [['Bollinger Bands', 'RSI'], ['VWAP', 'Stochastic'], ['Mean price', 'ATR']],
    whale_watcher: [['Volume spikes', 'Order book'], ['Open interest', 'Liquidations'], ['Whale alerts']],
    news_reactive: [['Sentiment score', 'News volume'], ['Social mentions', 'Fear/Greed'], ['Reddit activity']],
    contrarian: [['RSI extremes', 'Sentiment'], ['Put/Call ratio', 'Funding rate'], ['Crowd positioning']],
    noise: [['Random'], ['Price action'], ['Gut feeling']],
    funding_arb: [['Funding rate', 'Basis'], ['OI change', 'Spot premium'], ['Next funding time']],
  }
  const options = map[archetype]
  return options[Math.floor(Math.random() * options.length)]
}

function describePersona(archetype: PersonaArchetype, bias: string, risk: number): string {
  const riskLabel = risk > 0.7 ? 'aggressive' : risk > 0.4 ? 'moderate' : 'conservative'
  const descriptions: Record<PersonaArchetype, string> = {
    momentum: `Follows trend momentum. ${riskLabel} risk, ${bias} bias.`,
    mean_reversion: `Trades mean reversion. Buys dips, sells rallies. ${riskLabel}.`,
    whale_watcher: `Follows large player activity. ${riskLabel}, ${bias} leaning.`,
    news_reactive: `Reacts to news sentiment. Fast moving, ${riskLabel}.`,
    contrarian: `Deliberately opposes consensus. ${riskLabel}, ${bias} bias.`,
    noise: `Random behavior for calibration. No consistent strategy.`,
    funding_arb: `Trades funding rate arbitrage. ${riskLabel}, market neutral preferred.`,
  }
  return descriptions[archetype]
}
