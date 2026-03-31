import type { Signal } from '../types'

interface ResolvedSignal {
  winner: Signal
  conflicts: Signal[]
  confidenceReduction: number
}

export function resolveConflicts(signals: Signal[]): ResolvedSignal[] {
  const grouped = groupByTarget(signals)
  const resolved: ResolvedSignal[] = []

  for (const [_key, group] of Object.entries(grouped)) {
    if (group.length === 1) {
      resolved.push({
        winner: group[0],
        conflicts: [],
        confidenceReduction: 0,
      })
      continue
    }

    const conflicting = detectConflicts(group)
    if (conflicting.length === 0) {
      for (const signal of group) {
        resolved.push({
          winner: signal,
          conflicts: [],
          confidenceReduction: 0,
        })
      }
      continue
    }

    const sorted = conflicting.sort(
      (a, b) => b.adjustedConfidence - a.adjustedConfidence,
    )
    const winner = { ...sorted[0] }
    const losers = sorted.slice(1)

    // Reduce winner confidence by 20% due to conflict
    const reduction = 0.20
    winner.adjustedConfidence = winner.adjustedConfidence * (1 - reduction)

    resolved.push({
      winner,
      conflicts: losers,
      confidenceReduction: reduction,
    })
  }

  return resolved
}

function groupByTarget(signals: Signal[]): Record<string, Signal[]> {
  const groups: Record<string, Signal[]> = {}

  for (const signal of signals) {
    const payload = signal.payload as unknown as Record<string, unknown>
    const key = `${signal.type}:${(payload.symbol as string) ?? 'global'}:${(payload.parameter as string) ?? signal.type}`

    if (!groups[key]) {
      groups[key] = []
    }
    groups[key].push(signal)
  }

  return groups
}

function detectConflicts(signals: Signal[]): Signal[] {
  if (signals.length <= 1) return []

  // Check if signals suggest opposing directions
  const directions = signals.map((s) => {
    const payload = s.payload as unknown as Record<string, unknown>
    if ('newValue' in payload && 'oldValue' in payload) {
      return (payload.newValue as number) > (payload.oldValue as number)
        ? 'increase'
        : 'decrease'
    }
    if ('suggestedSpacing' in payload && 'currentSpacing' in payload) {
      return (payload.suggestedSpacing as number) >
        (payload.currentSpacing as number)
        ? 'widen'
        : 'tighten'
    }
    return 'neutral'
  })

  const hasConflict = new Set(directions).size > 1

  return hasConflict ? signals : []
}
