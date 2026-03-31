export interface Signal {
  id: string
  timestamp: number
  ttlHours: number
  source: 'autoresearch' | 'mirofish' | 'sentiment' | 'manual'
  confidence: number
  adjustedConfidence: number
  type: 'param_change' | 'regime_prediction' | 'spacing_suggestion' | 'allocation_change'
  payload: ParamChangePayload | RegimePredictionPayload | SpacingSuggestionPayload
  reasoning: string
  status: 'pending' | 'applied' | 'expired' | 'reverted'
  appliedAt?: number
  revertedAt?: number
  pnlBefore?: number
  pnlAfter?: number
}

export interface ParamChangePayload {
  parameter: string
  symbol?: string
  oldValue: number
  newValue: number
  backtestScore?: number
  baselineScore?: number
}

export interface RegimePredictionPayload {
  symbol: string
  predictedRegime: string
  currentRegime: string
  consensusPct: number
  contrariaDissent: number
}

export interface SpacingSuggestionPayload {
  symbol: string
  currentSpacing: number
  suggestedSpacing: number
  reason: string
}

export interface ElPesosStatus {
  balance: number
  positions: PositionInfo[]
  riskGuards: RiskGuardStatus
  regime: Record<string, string>
  funding: Record<string, FundingInfo>
  learning: LearningStatus
}

export interface PositionInfo {
  symbol: string
  positionAmt: number
  entryPrice: number
  markPrice: number
  unrealizedProfit: number
  leverage: number
}

export interface RiskGuardStatus {
  halt: boolean
  tilt: boolean
  cooldowns: Record<string, boolean>
  leverageTier: number
  sizeMult: number
}

export interface FundingInfo {
  rate: number
  bias: string
  nextFundingTime: number
}

export interface LearningStatus {
  status: Record<string, unknown>
  pending: unknown[]
  recent: unknown[]
}

export interface BinanceIncome {
  symbol: string
  incomeType: 'REALIZED_PNL' | 'COMMISSION' | 'FUNDING_FEE'
  income: string
  time: number
  tradeId?: string
}

export interface BinanceBalance {
  totalWalletBalance: number
  availableBalance: number
  totalUnrealizedProfit: number
}

export interface PerformanceSnapshot {
  symbol: string
  timestamp: number
  fills: number
  roundTrips: number
  pnlUsdt: number
  avgPnlPerTrip: number
  netExposure: number
  unrealizedPnl: number
  spacingUsed: number
  adxValue: number
  adxTier: string
  centerPrice: number
  allocation: number
  repositionCount: number
  marginErrors: number
  fundingRate: number
}

export interface DailyPnl {
  day: string
  trades: number
  wins: number
  pnl: number
  grossPnl: number
  fees: number
  funding: number
}

export interface WeeklyGoal {
  weekStart: string
  target: number
  actual: number
  achieved: boolean
  multiplierAtWeekEnd: number
  topModule: string
  topModuleRevenue: number
}

export interface Indicators {
  [symbol: string]: {
    close: number
    rsi: number
    macdHist: number
    adx: number
    supertrendDir: number
    rsiDiv: string
    bbSqueeze: boolean
    bbDir: string
    hurst: number
    permEntropy: number
  }
}

export interface WatchdogState {
  consecutiveFails: number
  lastSuccessAt: number
  lastFailAt: number
  lastRestartAttemptAt: number
}
