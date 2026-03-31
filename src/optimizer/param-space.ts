/**
 * Parameter space for autoresearch optimization.
 * Mirrors El Pesos config.ts tunable parameters.
 */

export interface ParamSet {
  baseSpacingPct: number
  atrSpacingMult: number
  adxNeutral: number
  adxBias: number
  adxDirectional: number
  biasSpacingMult: number
  directionalSpacingMult: number
  repositionPct: number
  ethAllocation: number
  solAllocation: number
  taoAllocation: number
}

export interface ParamBounds {
  min: number
  max: number
  step: number
}

export const PARAM_BOUNDS: Record<keyof ParamSet, ParamBounds> = {
  baseSpacingPct:        { min: 0.0025, max: 0.0060, step: 0.0005 },
  atrSpacingMult:        { min: 0.15,   max: 0.50,   step: 0.05 },
  adxNeutral:            { min: 15,     max: 25,     step: 1 },
  adxBias:               { min: 25,     max: 35,     step: 1 },
  adxDirectional:        { min: 35,     max: 50,     step: 2 },
  biasSpacingMult:       { min: 1.1,    max: 1.6,    step: 0.1 },
  directionalSpacingMult:{ min: 1.2,    max: 2.0,    step: 0.1 },
  repositionPct:         { min: 0.010,  max: 0.025,  step: 0.002 },
  ethAllocation:         { min: 40,     max: 70,     step: 5 },
  solAllocation:         { min: 25,     max: 50,     step: 5 },
  taoAllocation:         { min: 30,     max: 55,     step: 5 },
}

export const CURRENT_DEFAULTS: ParamSet = {
  baseSpacingPct: 0.0035,
  atrSpacingMult: 0.30,
  adxNeutral: 20,
  adxBias: 30,
  adxDirectional: 40,
  biasSpacingMult: 1.3,
  directionalSpacingMult: 1.5,
  repositionPct: 0.015,
  ethAllocation: 55,
  solAllocation: 35,
  taoAllocation: 40,
}

export function clampParams(params: ParamSet): ParamSet {
  const result = { ...params }
  for (const [key, bounds] of Object.entries(PARAM_BOUNDS)) {
    const k = key as keyof ParamSet
    result[k] = Math.max(bounds.min, Math.min(bounds.max, result[k]))
    // Round to step
    result[k] = Math.round(result[k] / bounds.step) * bounds.step
  }
  return result
}

export function paramDistance(a: ParamSet, b: ParamSet): number {
  let totalDist = 0
  for (const [key, bounds] of Object.entries(PARAM_BOUNDS)) {
    const k = key as keyof ParamSet
    const range = bounds.max - bounds.min
    if (range > 0) {
      totalDist += Math.abs(a[k] - b[k]) / range
    }
  }
  return totalDist / Object.keys(PARAM_BOUNDS).length
}

export function maxChangePct(original: ParamSet, modified: ParamSet): number {
  let maxChange = 0
  for (const key of Object.keys(PARAM_BOUNDS) as Array<keyof ParamSet>) {
    if (original[key] !== 0) {
      const changePct = Math.abs(modified[key] - original[key]) / original[key]
      maxChange = Math.max(maxChange, changePct)
    }
  }
  return maxChange
}
