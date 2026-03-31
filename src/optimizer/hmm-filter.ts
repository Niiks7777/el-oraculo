/**
 * HMM Forward Filter — computes state probabilities from trained model.
 *
 * Given a sequence of hourly log-returns and a trained 2-state GaussianHMM,
 * returns P(state_t | returns_1..t) at each timestep.
 */

import * as fs from 'fs'

export interface HMMModel {
  pair: string
  n_states: number
  means: number[]
  covars: number[]
  transmat: number[][]
  startprob: number[]
}

export interface HMMState {
  state: number           // argmax state (0=normal, 1=spike)
  probabilities: number[] // [P(normal), P(spike)]
  confidence: number      // max(probabilities)
}

export function loadHMMModel(pair: string): HMMModel {
  const path = `./backtest-data/${pair}_hmm_model.json`
  return JSON.parse(fs.readFileSync(path, 'utf-8'))
}

/**
 * Gaussian PDF: P(x | mu, sigma^2)
 */
function gaussianPdf(x: number, mean: number, variance: number): number {
  const std = Math.sqrt(variance)
  if (std === 0) return 0
  const exponent = -0.5 * ((x - mean) / std) ** 2
  return (1 / (std * Math.sqrt(2 * Math.PI))) * Math.exp(exponent)
}

/**
 * Forward algorithm for HMM.
 * Given a sequence of observations, computes filtered state probabilities.
 */
export function forwardFilter(
  model: HMMModel,
  observations: number[],
): HMMState[] {
  const n = model.n_states
  const states: HMMState[] = []

  // Initialize with start probabilities × emission
  let alpha = new Array(n)
  for (let s = 0; s < n; s++) {
    alpha[s] = model.startprob[s] * gaussianPdf(observations[0], model.means[s], model.covars[s])
  }
  alpha = normalize(alpha)

  states.push(toHMMState(alpha))

  // Forward pass
  for (let t = 1; t < observations.length; t++) {
    const newAlpha = new Array(n).fill(0)

    for (let j = 0; j < n; j++) {
      let sum = 0
      for (let i = 0; i < n; i++) {
        sum += alpha[i] * model.transmat[i][j]
      }
      newAlpha[j] = sum * gaussianPdf(observations[t], model.means[j], model.covars[j])
    }

    alpha = normalize(newAlpha)
    states.push(toHMMState(alpha))
  }

  return states
}

/**
 * Get current state probability from latest candle data.
 * Aggregates 1m candles to hourly returns, runs forward filter.
 */
export function getCurrentHMMState(
  model: HMMModel,
  hourlyCloses: number[],
): HMMState {
  if (hourlyCloses.length < 2) {
    return { state: 0, probabilities: [1, 0], confidence: 1 }
  }

  // Compute log returns
  const returns: number[] = []
  for (let i = 1; i < hourlyCloses.length; i++) {
    returns.push(Math.log(hourlyCloses[i] / hourlyCloses[i - 1]))
  }

  const states = forwardFilter(model, returns)
  return states[states.length - 1]
}

function normalize(arr: number[]): number[] {
  const sum = arr.reduce((s, v) => s + v, 0)
  if (sum === 0) return arr.map(() => 1 / arr.length)
  return arr.map((v) => v / sum)
}

function toHMMState(probs: number[]): HMMState {
  let maxIdx = 0
  let maxVal = probs[0]
  for (let i = 1; i < probs.length; i++) {
    if (probs[i] > maxVal) {
      maxVal = probs[i]
      maxIdx = i
    }
  }
  return {
    state: maxIdx,
    probabilities: [...probs],
    confidence: maxVal,
  }
}
