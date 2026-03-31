import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { CONFIG } from '../config'
import type { Signal } from '../types'

const SIGNALS_DIR = CONFIG.paths.signals

export function createSignal(
  partial: Omit<Signal, 'id' | 'timestamp' | 'status' | 'adjustedConfidence'>,
  confidenceMultiplier: number,
): Signal {
  const adjustedConfidence = Math.min(
    partial.confidence * confidenceMultiplier,
    CONFIG.confidence.maxMultiplier,
  )

  const signal: Signal = {
    ...partial,
    id: randomUUID(),
    timestamp: Date.now(),
    adjustedConfidence,
    status: 'pending',
  }

  const filename = `${signal.source}_${signal.type}_${signal.id}.json`
  const filepath = path.join(SIGNALS_DIR, filename)
  fs.writeFileSync(filepath, JSON.stringify(signal, null, 2))

  return signal
}

export function readPendingSignals(): Signal[] {
  const files = fs.readdirSync(SIGNALS_DIR).filter((f) => f.endsWith('.json'))
  const now = Date.now()
  const signals: Signal[] = []

  for (const file of files) {
    try {
      const filepath = path.join(SIGNALS_DIR, file)
      const data = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as Signal

      const expiresAt = data.timestamp + data.ttlHours * 60 * 60 * 1000
      if (now > expiresAt) {
        fs.unlinkSync(filepath)
        continue
      }

      if (data.status === 'pending') {
        signals.push(data)
      }
    } catch {
      // skip malformed files
    }
  }

  return signals.sort((a, b) => b.adjustedConfidence - a.adjustedConfidence)
}

export function updateSignalStatus(
  signalId: string,
  status: Signal['status'],
  extra?: Partial<Signal>,
): void {
  const files = fs.readdirSync(SIGNALS_DIR).filter((f) => f.includes(signalId))

  for (const file of files) {
    const filepath = path.join(SIGNALS_DIR, file)
    try {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as Signal
      const updated = { ...data, status, ...extra }
      fs.writeFileSync(filepath, JSON.stringify(updated, null, 2))
    } catch {
      // skip
    }
  }
}

export function getAppliedSignals(lastHours = 24): Signal[] {
  const files = fs.readdirSync(SIGNALS_DIR).filter((f) => f.endsWith('.json'))
  const cutoff = Date.now() - lastHours * 60 * 60 * 1000
  const signals: Signal[] = []

  for (const file of files) {
    try {
      const filepath = path.join(SIGNALS_DIR, file)
      const data = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as Signal
      if (data.status === 'applied' && (data.appliedAt ?? 0) > cutoff) {
        signals.push(data)
      }
    } catch {
      // skip
    }
  }

  return signals
}

export function cleanupExpiredSignals(): number {
  const files = fs.readdirSync(SIGNALS_DIR).filter((f) => f.endsWith('.json'))
  const now = Date.now()
  let cleaned = 0

  for (const file of files) {
    try {
      const filepath = path.join(SIGNALS_DIR, file)
      const data = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as Signal
      const expiresAt = data.timestamp + data.ttlHours * 60 * 60 * 1000

      if (now > expiresAt && data.status !== 'applied') {
        fs.unlinkSync(filepath)
        cleaned++
      }
    } catch {
      // skip
    }
  }

  return cleaned
}

export function getSignalHistory(limit = 50): Signal[] {
  const files = fs.readdirSync(SIGNALS_DIR).filter((f) => f.endsWith('.json'))
  const signals: Signal[] = []

  for (const file of files) {
    try {
      const filepath = path.join(SIGNALS_DIR, file)
      const data = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as Signal
      signals.push(data)
    } catch {
      // skip
    }
  }

  return signals
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
}
