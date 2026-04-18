import { useState, useEffect } from 'react'
import './App.css'

const Icon = {
  Logo: (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M6 21h12" />
      <path d="M8 21v-7" />
      <path d="M16 21v-7" />
      <path d="M5 14h14" />
      <path d="M6 10h12" />
      <path d="M5 4v4h2V5h2v3h2V5h2v3h2V5h2v3h2V4Z" />
    </svg>
  ),
  Power: (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...props}>
      <path d="M12 3v9" />
      <path d="M6.5 7a8 8 0 1 0 11 0" />
    </svg>
  ),
  Layers: (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 3 3 8l9 5 9-5Z" />
      <path d="M3 13l9 5 9-5" />
      <path d="M3 17l9 5 9-5" />
    </svg>
  ),
  Signal: (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 21h4v-6H3z" />
      <path d="M10 21h4v-10h-4z" />
      <path d="M17 21h4V5h-4z" />
    </svg>
  ),
  Plug: (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9 3v4" />
      <path d="M15 3v4" />
      <path d="M7 7h10v5a5 5 0 0 1-10 0z" />
      <path d="M12 17v4" />
    </svg>
  ),
  Compass: (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15 9-3 7-3-7 6 2z" />
    </svg>
  ),
}

const statusCopy = {
  loading: 'Booting',
  ready: 'Standby',
  testing: 'Pinging',
  connected: 'Online',
  error: 'Offline',
}

const statusTone = {
  loading: 'idle',
  ready: 'idle',
  testing: 'thinking',
  connected: 'ready',
  error: 'error',
}

function App() {
  const [settings, setSettings] = useState({
    enabled: true,
    depth: 15,
    backendUrl: 'http://localhost:5000',
  })
  const [status, setStatus] = useState('loading')

  useEffect(() => {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.sync.get(['chessAnalysisSettings'], (result) => {
        if (result.chessAnalysisSettings) {
          setSettings((prev) => ({ ...prev, ...result.chessAnalysisSettings }))
        }
        setStatus('ready')
      })
    } else {
      setStatus('ready')
    }
  }, [])

  const saveSettings = (next) => {
    setSettings(next)
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.sync.set({ chessAnalysisSettings: next })
    }
  }

  const testConnection = async () => {
    setStatus('testing')
    try {
      const response = await fetch(`${settings.backendUrl}/health`)
      const data = await response.json()
      setStatus(data.status === 'ok' ? 'connected' : 'error')
    } catch {
      setStatus('error')
    }
  }

  const tone = statusTone[status] || 'idle'

  return (
    <div className="relative w-[340px] min-h-[440px] overflow-hidden font-[Inter,system-ui,sans-serif] text-slate-100">
      {/* Background */}
      <div className="absolute inset-0 -z-10 bg-[#0a0c14]" />
      <div
        className="pointer-events-none absolute -top-24 -right-20 h-64 w-64 rounded-full blur-3xl -z-10"
        style={{ background: 'radial-gradient(closest-side, rgba(130,110,255,0.45), transparent 70%)' }}
      />
      <div
        className="pointer-events-none absolute -bottom-28 -left-24 h-64 w-64 rounded-full blur-3xl -z-10"
        style={{ background: 'radial-gradient(closest-side, rgba(80,180,255,0.30), transparent 70%)' }}
      />

      <div className="relative p-5">
        {/* Header */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 text-indigo-100"
              style={{ background: 'linear-gradient(145deg, rgba(255,255,255,0.10), rgba(255,255,255,0.02))' }}
            >
              <Icon.Logo className="h-[18px] w-[18px]" />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-[13px] font-semibold tracking-[0.01em] text-white">Chess Analysis</span>
              <span className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-indigo-200/50">
                Engine overlay
              </span>
            </div>
          </div>

          <StatusPill tone={tone} label={statusCopy[status] || status} />
        </header>

        {/* Enable card */}
        <Card className="mt-5">
          <CardHead icon={<Icon.Power />} label="Analysis overlay" />
          <div className="mt-2 flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-[13px] font-medium text-white">
                {settings.enabled ? 'Active' : 'Paused'}
              </span>
              <span className="text-[11px] text-indigo-200/55">
                Show best moves on chess.com pages
              </span>
            </div>
            <Toggle
              checked={settings.enabled}
              onChange={() => saveSettings({ ...settings, enabled: !settings.enabled })}
            />
          </div>
        </Card>

        {/* Depth */}
        <Card className="mt-3">
          <CardHead icon={<Icon.Layers />} label="Analysis depth" />
          <div className="mt-3 flex items-center gap-2">
            {[10, 15, 20].map((depth) => {
              const active = settings.depth === depth
              return (
                <button
                  key={depth}
                  onClick={() => saveSettings({ ...settings, depth })}
                  className={[
                    'relative flex-1 rounded-lg px-3 py-2 text-[12px] font-medium tracking-wide transition-all',
                    'border',
                    active
                      ? 'border-white/20 bg-white/10 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
                      : 'border-white/5 bg-white/[0.03] text-indigo-100/70 hover:bg-white/[0.06] hover:text-white',
                  ].join(' ')}
                >
                  {depth}
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-[10.5px] text-indigo-200/45 uppercase tracking-[0.14em]">
            Higher depth, stronger play, slower replies
          </p>
        </Card>

        {/* Backend */}
        <Card className="mt-3">
          <CardHead icon={<Icon.Plug />} label="Backend" />
          <input
            type="text"
            value={settings.backendUrl}
            onChange={(e) => saveSettings({ ...settings, backendUrl: e.target.value })}
            placeholder="http://localhost:5000"
            className="mt-2 w-full rounded-lg border border-white/8 bg-black/30 px-3 py-2 text-[12px] text-slate-100 placeholder-indigo-200/30 outline-none focus:border-indigo-300/40 focus:bg-black/40 transition"
          />
          <button
            onClick={testConnection}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] py-2 text-[12px] font-medium text-slate-100 transition hover:bg-white/[0.12]"
          >
            <Icon.Signal className="h-4 w-4" />
            <span>Test connection</span>
          </button>
        </Card>

        {/* Instructions */}
        <Card className="mt-3">
          <CardHead icon={<Icon.Compass />} label="Quick start" />
          <ol className="mt-2 space-y-1.5 text-[12px] text-indigo-100/75">
            <Step index="01" text="Open a live or offline chess.com game." />
            <Step index="02" text="The overlay attaches in the top-right corner." />
            <Step index="03" text="The best move refreshes after each half-move." />
          </ol>
        </Card>
      </div>
    </div>
  )
}

function Card({ className = '', children }) {
  return (
    <section
      className={[
        'rounded-2xl border border-white/[0.07] p-4',
        'bg-white/[0.035]',
        '[backdrop-filter:blur(18px)_saturate(140%)]',
        '[-webkit-backdrop-filter:blur(18px)_saturate(140%)]',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]',
        className,
      ].join(' ')}
    >
      {children}
    </section>
  )
}

function CardHead({ icon, label }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex h-4 w-4 items-center justify-center text-indigo-100/70">{icon}</span>
      <span className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-indigo-200/55">
        {label}
      </span>
    </div>
  )
}

function Toggle({ checked, onChange }) {
  return (
    <button
      onClick={onChange}
      className={[
        'relative inline-flex h-[22px] w-[40px] items-center rounded-full border transition-all',
        checked
          ? 'border-white/20 bg-gradient-to-r from-indigo-400/80 to-violet-400/80'
          : 'border-white/10 bg-white/[0.06]',
      ].join(' ')}
      aria-pressed={checked}
    >
      <span
        className={[
          'absolute top-[2px] h-[16px] w-[16px] rounded-full bg-white transition-transform',
          'shadow-[0_1px_2px_rgba(0,0,0,0.3)]',
          checked ? 'translate-x-[20px]' : 'translate-x-[2px]',
        ].join(' ')}
      />
    </button>
  )
}

function StatusPill({ tone, label }) {
  const dotColor = {
    idle: 'bg-slate-400 shadow-[0_0_0_2px_rgba(148,163,184,0.18)]',
    thinking: 'bg-amber-300 shadow-[0_0_0_2px_rgba(252,211,77,0.22)] animate-pulse',
    ready: 'bg-emerald-300 shadow-[0_0_0_2px_rgba(110,231,183,0.22)]',
    error: 'bg-rose-400 shadow-[0_0_0_2px_rgba(251,113,133,0.22)]',
  }[tone] || 'bg-slate-400'

  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-[0.14em] text-indigo-100/75">
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
      <span>{label}</span>
    </div>
  )
}

function Step({ index, text }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-[1px] text-[10px] font-mono text-indigo-200/45">{index}</span>
      <span>{text}</span>
    </li>
  )
}

export default App
