import { z } from 'zod'

const envSchema = z.object({
  OPENROUTER_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  PGVECTOR_URL: z.string().default('postgresql://user:password@localhost:5432/oraculo'),
  EL_PESOS_API: z.string().default('http://localhost:4201'),
  RELAY_API: z.string().default('http://localhost:4202'),
  ORACULO_PORT: z.string().default('4203'),
  OPENROUTER_DAILY_CAP: z.string().default('5'),
})

const env = envSchema.parse(process.env)

export const CONFIG = {
  elPesos: {
    apiUrl: env.EL_PESOS_API,
    relayUrl: env.RELAY_API,
  },

  ollama: {
    url: env.OLLAMA_URL,
    model: 'llama3',
    embedModel: 'nomic-embed-text',
  },

  openRouter: {
    apiKey: env.OPENROUTER_API_KEY ?? '',
    dailyCapUsd: parseFloat(env.OPENROUTER_DAILY_CAP),
    model: 'anthropic/claude-sonnet-4-20250514',
    mirofishModel: 'nvidia/nemotron-3-super-120b-a12b:free',
  },

  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: env.TELEGRAM_CHAT_ID ?? '',
  },

  pgvector: {
    url: env.PGVECTOR_URL,
  },

  paths: {
    signals: './signals',
    reports: './reports',
    backtestData: './backtest-data',
    tradingDb: '/shared/trading-db/trading.db',
  },

  schedules: {
    collectorIntervalMs: 5 * 60 * 1000,        // 5 min
    autoresearchIntervalMs: 12 * 60 * 60 * 1000, // 12h
    mirofishIntervalMs: 4 * 60 * 60 * 1000,     // 4h
    watchdogIntervalMs: 30 * 1000,               // 30s
    goalEvalDay: 0,                               // Sunday
  },

  autoresearch: {
    maxIterationsPerCycle: 20,
    minImprovementPct: 0.02,
    maxParamChangePct: 0.10,
    backtestDays: 7,
    walkForwardSplit: [5, 2],
  },

  confidence: {
    baseMultiplier: 1.0,
    maxMultiplier: 1.5,
    minMultiplier: 0.5,
    winIncrement: 0.05,
    lossDecrement: 0.10,
    consecutiveMissReset: 3,
    pauseHoursOnReset: 6,
  },

  signalThresholds: {
    logOnly: 0.4,
    conservative: 0.6,
    full: 0.8,
  },

  safety: {
    autoRevertPnlDropPct: 0.15,
    autoRevertWindowHours: 24,
    maxRevertHistory: 3,
    killPauseHours: 12,
  },
} as const
