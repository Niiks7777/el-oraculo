import Database from 'better-sqlite3'
import * as fs from 'fs'
import { CONFIG } from '../config'
import type { PerformanceSnapshot } from '../types'

function openDb(): Database.Database | null {
  if (!fs.existsSync(CONFIG.paths.tradingDb)) return null
  return new Database(CONFIG.paths.tradingDb, { readonly: true })
}

export function getRecentSnapshots(hours = 84): PerformanceSnapshot[] {
  const db = openDb()
  if (!db) return []
  try {
    const cutoff = Date.now() - hours * 60 * 60 * 1000
    const rows = db
      .prepare(
        `SELECT symbol, timestamp, fills, round_trips, pnl_usdt,
                avg_pnl_per_trip, net_exposure, unrealized_pnl,
                spacing_used, adx_value, adx_tier, center_price,
                allocation, reposition_count, margin_errors, funding_rate
         FROM performance_snapshots
         WHERE timestamp > ?
         ORDER BY timestamp ASC`,
      )
      .all(cutoff) as PerformanceSnapshot[]
    return rows
  } finally {
    db.close()
  }
}

export function getLearningChanges(limit = 20): unknown[] {
  const db = openDb()
  if (!db) return []
  try {
    return db
      .prepare(
        `SELECT * FROM learning_changes
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit)
  } finally {
    db.close()
  }
}

export function getRecentTrades(limit = 100): unknown[] {
  const db = openDb()
  if (!db) return []
  try {
    return db
      .prepare(
        `SELECT * FROM trades
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit)
  } finally {
    db.close()
  }
}

export function getGridSessions(symbol?: string, limit = 20): unknown[] {
  const db = openDb()
  if (!db) return []
  try {
    if (symbol) {
      return db
        .prepare(
          `SELECT * FROM grid_sessions
           WHERE symbol = ?
           ORDER BY started_at DESC
           LIMIT ?`,
        )
        .all(symbol, limit)
    }
    return db
      .prepare(
        `SELECT * FROM grid_sessions
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(limit)
  } finally {
    db.close()
  }
}

export function getDailyPnlFromDb(days = 14): unknown[] {
  const db = openDb()
  if (!db) return []
  try {
    return db
      .prepare(
        `SELECT * FROM daily_pnl
         ORDER BY date DESC
         LIMIT ?`,
      )
      .all(days)
  } finally {
    db.close()
  }
}

export function getPlaybookPatterns(status = 'active'): unknown[] {
  const db = openDb()
  if (!db) return []
  try {
    return db
      .prepare(
        `SELECT * FROM playbook
         WHERE status = ?
         ORDER BY confidence DESC`,
      )
      .all(status)
  } finally {
    db.close()
  }
}

export function getNewsWithImpact(hours = 48): unknown[] {
  const db = openDb()
  if (!db) return []
  try {
    const cutoff = Date.now() - hours * 60 * 60 * 1000
    return db
      .prepare(
        `SELECT ne.*, pi.symbol as impact_symbol, pi.price_at_event,
                pi.delta_5m, pi.delta_15m, pi.delta_1h, pi.delta_4h, pi.delta_24h
         FROM news_events ne
         LEFT JOIN price_impacts pi ON ne.id = pi.news_id
         WHERE ne.fetched_at > ?
         ORDER BY ne.fetched_at DESC`,
      )
      .all(cutoff)
  } finally {
    db.close()
  }
}

export function getEquitySnapshots(hours = 24): unknown[] {
  const db = openDb()
  if (!db) return []
  try {
    const cutoff = Date.now() - hours * 60 * 60 * 1000
    return db
      .prepare(
        `SELECT * FROM equity_snapshots
         WHERE timestamp > ?
         ORDER BY timestamp ASC`,
      )
      .all(cutoff)
  } finally {
    db.close()
  }
}

export function getStateValue(key: string): string | undefined {
  const db = openDb()
  if (!db) return undefined
  try {
    const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  } finally {
    db.close()
  }
}

export function getDbLastModified(): number {
  const fs = require('fs')
  try {
    const stat = fs.statSync(CONFIG.paths.tradingDb)
    return stat.mtimeMs
  } catch {
    return 0
  }
}
