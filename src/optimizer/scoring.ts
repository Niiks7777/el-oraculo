/**
 * Scoring function — ALIGNED with El Pesos learning-engine.ts
 *
 * Real engine uses: 0.6 * fillRate + 0.4 * avgPnlPerTrip
 * NOT win rate. Fill rate measures grid efficiency (how often are orders
 * getting filled), pnlPerTrip measures quality per round-trip.
 */

import type { BacktestResult } from './backtest-engine'

export interface ScoreBreakdown {
  fillRateScore: number
  pnlPerTripScore: number
  compositeScore: number
  totalScore: number
}

export function scoreResult(
  result: BacktestResult,
  _allocation: number,
): ScoreBreakdown {
  // Fill rate: fills per hour, normalized to [0, 1] with cap at 10/hr
  const fillRateScore = Math.min(result.fillRate / 10, 1.0)

  // P&L per trip: avg profit per round-trip in dollars, normalized to [0, 1] with cap at $1.00
  const pnlPerTripScore = Math.min(Math.max(result.avgPnlPerTrip, 0) / 1.0, 1.0)

  // Composite — matches real learning engine exactly
  const compositeScore = fillRateScore * 0.6 + pnlPerTripScore * 0.4

  return {
    fillRateScore,
    pnlPerTripScore,
    compositeScore,
    totalScore: compositeScore,
  }
}

export function isImprovement(
  baseline: ScoreBreakdown,
  candidate: ScoreBreakdown,
  minImprovementPct: number,
): boolean {
  if (baseline.totalScore === 0) return candidate.totalScore > 0
  const improvement =
    (candidate.totalScore - baseline.totalScore) / baseline.totalScore
  return improvement >= minImprovementPct
}
