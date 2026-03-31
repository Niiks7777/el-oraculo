import express from 'express'
import * as fs from 'fs'
import { CONFIG } from '../config'
import { getSchedulerStatus } from './scheduler'
import { getState as getConfidenceState } from './confidence-tracker'
import { getSignalHistory, readPendingSignals } from './signal-bus'
import { getWatchdogState } from './watchdog'

// Pro modules — loaded dynamically
let getCurrentGoal: (() => unknown) | null = null
let getGoalHistory: (() => unknown[]) | null = null
let getEvolutionReport: (() => unknown) | null = null
try { const m = require('./goal-system'); getCurrentGoal = m.getCurrentGoal; getGoalHistory = m.getGoalHistory } catch { /* Pro */ }
try { const m = require('../evolution/skill-tracker'); getEvolutionReport = m.getEvolutionReport } catch { /* Pro */ }
import pino from 'pino'

const log = pino({ name: 'dashboard' })

export function startDashboard(): void {
  const app = express()
  const port = 4203

  app.use(express.json())

  // --- API ENDPOINTS ---

  app.get('/api/status', (_req, res) => {
    res.json(getSchedulerStatus())
  })

  app.get('/api/confidence', (_req, res) => {
    res.json(getConfidenceState())
  })

  app.get('/api/goals', (_req, res) => {
    res.json({
      current: getCurrentGoal ? getCurrentGoal() : null,
      history: getGoalHistory ? getGoalHistory() : [],
    })
  })

  app.get('/api/signals', (req, res) => {
    const limit = parseInt((req.query.limit as string) ?? '50')
    res.json(getSignalHistory(limit))
  })

  app.get('/api/signals/pending', (_req, res) => {
    res.json(readPendingSignals())
  })

  app.get('/api/watchdog', (_req, res) => {
    res.json(getWatchdogState())
  })

  app.get('/api/evolution', (_req, res) => {
    res.json(getEvolutionReport ? getEvolutionReport() : { active: [], promoted: [], deprecated: [], totalRevenue: 0, topSkill: null })
  })

  app.get('/api/autoresearch', (_req, res) => {
    try {
      const state = JSON.parse(
        fs.readFileSync('./autoresearch-state.json', 'utf-8'),
      )
      const results = fs.existsSync('./autoresearch-results.tsv')
        ? fs.readFileSync('./autoresearch-results.tsv', 'utf-8')
            .split('\n')
            .slice(1)
            .filter(Boolean)
            .map((line) => {
              const [iter, score, baseline, status, param, oldVal, newVal, desc] = line.split('\t')
              return { iter, score, baseline, status, param, oldVal, newVal, desc }
            })
        : []
      res.json({ state, experiments: results })
    } catch {
      res.json({ state: null, experiments: [] })
    }
  })

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() })
  })

  // --- DASHBOARD UI ---

  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.send(getDashboardHtml())
  })

  app.listen(port, '0.0.0.0', () => {
    log.info({ port }, 'Oraculo dashboard started')
  })
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>El Oraculo — Command Center</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0a0a0f; --surface: #12121a; --surface2: #1a1a25;
      --border: #2a2a3a; --text: #e0e0e8; --dim: #888899;
      --accent: #8b5cf6; --green: #22c55e; --red: #ef4444;
      --amber: #f59e0b; --cyan: #06b6d4;
    }
    body {
      background: var(--bg); color: var(--text);
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 13px; line-height: 1.5;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    h1 { font-size: 20px; color: var(--accent); margin-bottom: 4px; }
    .subtitle { color: var(--dim); font-size: 11px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 16px; }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 16px;
      background-image: linear-gradient(135deg, rgba(139,92,246,0.03) 0%, transparent 50%);
    }
    .card h2 { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
    .metric { font-size: 28px; font-weight: 700; }
    .metric.green { color: var(--green); }
    .metric.red { color: var(--red); }
    .metric.amber { color: var(--amber); }
    .metric.cyan { color: var(--cyan); }
    .label { font-size: 11px; color: var(--dim); margin-top: 4px; }
    .bar { height: 6px; background: var(--surface2); border-radius: 3px; margin: 8px 0; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 3px; transition: width 0.5s; }
    .bar-fill.green { background: var(--green); }
    .bar-fill.accent { background: var(--accent); }
    .bar-fill.amber { background: var(--amber); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; color: var(--dim); padding: 6px 8px; border-bottom: 1px solid var(--border); }
    td { padding: 6px 8px; border-bottom: 1px solid rgba(42,42,58,0.5); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; }
    .badge.keep { background: rgba(34,197,94,0.15); color: var(--green); }
    .badge.discard { background: rgba(239,68,68,0.15); color: var(--red); }
    .badge.active { background: rgba(139,92,246,0.15); color: var(--accent); }
    .badge.promoted { background: rgba(34,197,94,0.15); color: var(--green); }
    .badge.deprecated { background: rgba(239,68,68,0.15); color: var(--red); }
    .pulse { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; animation: pulse 2s infinite; }
    .pulse.green { background: var(--green); }
    .pulse.red { background: var(--red); }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    .status-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; }
    #loading { text-align: center; padding: 40px; color: var(--dim); }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔮 El Oraculo</h1>
    <div class="subtitle">Autonomous Enhancement Engine — refreshes every 5s</div>

    <div class="grid" id="top-cards"></div>
    <div class="grid" id="mid-cards"></div>
    <div id="tables"></div>
    <div id="loading">Loading...</div>
  </div>

  <script>
    async function fetchAll() {
      const [status, confidence, goals, signals, watchdog, evolution, autoresearch] = await Promise.all([
        fetch('/api/status').then(r => r.json()).catch(() => null),
        fetch('/api/confidence').then(r => r.json()).catch(() => null),
        fetch('/api/goals').then(r => r.json()).catch(() => null),
        fetch('/api/signals?limit=20').then(r => r.json()).catch(() => []),
        fetch('/api/watchdog').then(r => r.json()).catch(() => null),
        fetch('/api/evolution').then(r => r.json()).catch(() => null),
        fetch('/api/autoresearch').then(r => r.json()).catch(() => null),
      ]);
      return { status, confidence, goals, signals, watchdog, evolution, autoresearch };
    }

    function render(data) {
      document.getElementById('loading').style.display = 'none';
      const { status, confidence, goals, signals, watchdog, evolution, autoresearch } = data;

      // Top cards
      const mult = confidence?.multiplier ?? 1;
      const multClass = mult >= 1.2 ? 'green' : mult <= 0.8 ? 'red' : 'cyan';
      const goal = goals?.current;
      const goalPct = goal ? Math.min(100, (goal.actual / goal.target) * 100) : 0;
      const wdFails = watchdog?.consecutiveFails ?? 0;
      const running = status?.running ?? false;

      document.getElementById('top-cards').innerHTML = \`
        <div class="card">
          <h2>System Status</h2>
          <div class="status-row">
            <span><span class="pulse \${running ? 'green' : 'red'}"></span>\${running ? 'ONLINE' : 'OFFLINE'}</span>
            <span class="dim">Uptime: \${status ? Math.floor(status.uptime ?? 0) + 's' : '—'}</span>
          </div>
          <div class="status-row">
            <span>Watchdog</span>
            <span>\${wdFails === 0 ? '✓ Healthy' : '⚠ ' + wdFails + ' fails'}</span>
          </div>
          <div class="status-row">
            <span>Pending Signals</span>
            <span>\${status?.pendingSignals ?? 0}</span>
          </div>
        </div>
        <div class="card">
          <h2>Confidence Multiplier</h2>
          <div class="metric \${multClass}">\${mult.toFixed(2)}x</div>
          <div class="bar"><div class="bar-fill \${multClass}" style="width:\${(mult/1.5)*100}%"></div></div>
          <div class="label">Wins: \${confidence?.consecutiveWins ?? 0} | Misses: \${confidence?.consecutiveMisses ?? 0}\${confidence?.pausedUntil ? ' | PAUSED' : ''}</div>
        </div>
        <div class="card">
          <h2>Weekly Goal</h2>
          <div class="metric \${goalPct >= 100 ? 'green' : goalPct > 50 ? 'amber' : 'red'}">
            \${goal ? '$' + goal.actual.toFixed(2) : '—'}
          </div>
          <div class="bar"><div class="bar-fill \${goalPct >= 100 ? 'green' : 'amber'}" style="width:\${goalPct}%"></div></div>
          <div class="label">Target: \${goal ? '$' + goal.target.toFixed(2) : '—'} (\${goalPct.toFixed(0)}%)</div>
        </div>
      \`;

      // Mid cards
      const evo = evolution;
      const ar = autoresearch;
      document.getElementById('mid-cards').innerHTML = \`
        <div class="card">
          <h2>Autoresearch</h2>
          <div class="status-row">
            <span>Iteration</span><span>\${ar?.state?.iteration ?? 0}</span>
          </div>
          <div class="status-row">
            <span>Kept</span><span class="green">\${ar?.state?.totalKept ?? 0}</span>
          </div>
          <div class="status-row">
            <span>Discarded</span><span class="red">\${ar?.state?.totalDiscarded ?? 0}</span>
          </div>
          <div class="status-row">
            <span>Score</span><span>\${ar?.state?.baselineScore?.toFixed(4) ?? '—'}</span>
          </div>
        </div>
        <div class="card">
          <h2>Skill Evolution</h2>
          <div class="status-row">
            <span>Active</span><span class="badge active">\${evo?.active?.length ?? 0}</span>
          </div>
          <div class="status-row">
            <span>Promoted</span><span class="badge promoted">\${evo?.promoted?.length ?? 0}</span>
          </div>
          <div class="status-row">
            <span>Deprecated</span><span class="badge deprecated">\${evo?.deprecated?.length ?? 0}</span>
          </div>
          <div class="status-row">
            <span>Total Revenue</span><span>$\${(evo?.totalRevenue ?? 0).toFixed(2)}</span>
          </div>
        </div>
      \`;

      // Signal table
      const sigRows = (Array.isArray(signals) ? signals : []).slice(0, 15).map(s => \`
        <tr>
          <td>\${new Date(s.timestamp).toLocaleTimeString()}</td>
          <td>\${s.source}</td>
          <td>\${s.type}</td>
          <td>\${(s.adjustedConfidence * 100).toFixed(0)}%</td>
          <td><span class="badge \${s.status === 'applied' ? 'keep' : s.status === 'reverted' ? 'discard' : 'active'}">\${s.status}</span></td>
          <td>\${s.reasoning?.slice(0, 60) ?? ''}</td>
        </tr>
      \`).join('');

      const expRows = (ar?.experiments ?? []).slice(-10).reverse().map(e => \`
        <tr>
          <td>\${e.iter}</td>
          <td>\${e.param}</td>
          <td>\${e.oldVal} → \${e.newVal}</td>
          <td>\${e.score}</td>
          <td><span class="badge \${e.status}">\${e.status}</span></td>
          <td>\${e.desc?.slice(0, 50) ?? ''}</td>
        </tr>
      \`).join('');

      document.getElementById('tables').innerHTML = \`
        <div class="card" style="margin-bottom:16px">
          <h2>Recent Signals</h2>
          <table>
            <tr><th>Time</th><th>Source</th><th>Type</th><th>Conf</th><th>Status</th><th>Reasoning</th></tr>
            \${sigRows || '<tr><td colspan="6" style="color:var(--dim)">No signals yet</td></tr>'}
          </table>
        </div>
        <div class="card">
          <h2>Autoresearch Experiments</h2>
          <table>
            <tr><th>#</th><th>Param</th><th>Change</th><th>Score</th><th>Status</th><th>Description</th></tr>
            \${expRows || '<tr><td colspan="6" style="color:var(--dim)">No experiments yet</td></tr>'}
          </table>
        </div>
      \`;
    }

    async function refresh() {
      try {
        const data = await fetchAll();
        render(data);
      } catch(e) {
        console.error('Refresh failed:', e);
      }
    }

    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`
}
