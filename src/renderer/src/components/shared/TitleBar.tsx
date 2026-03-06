import { useState, useEffect, useCallback } from 'react'
import { Minus, Square, X, Copy, Sun, Moon } from 'lucide-react'

function getSystemTheme(): string {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') ?? getSystemTheme())

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  const toggle = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }, [])

  return [theme, toggle]
}

export function TitleBar(): React.JSX.Element {
  const [isMaximized, setIsMaximized] = useState(false)
  const [theme, toggleTheme] = useTheme()

  useEffect(() => {
    window.api.window.isMaximized().then(setIsMaximized)
    window.api.window.onMaximizedChanged(setIsMaximized)
  }, [])

  return (
    <div
      className="flex h-8 shrink-0 items-center justify-between bg-[var(--background-secondary)] select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left: app name */}
      <div className="flex items-center gap-2 pl-3">
        <span className="text-[11px] font-medium text-[var(--text-muted)]">
          ClawdTime
        </span>
      </div>

      {/* Right: theme toggle + window controls */}
      <div
        className="flex h-full items-center"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={toggleTheme}
          className="flex h-full w-9 items-center justify-center text-[var(--text-muted)] hover:bg-[var(--background-elevated)] hover:text-[var(--text-secondary)] transition-colors"
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
        </button>
        <div className="mx-1 h-3 w-px bg-[var(--surface-border)]" />
        <button
          type="button"
          onClick={() => window.api.window.minimize()}
          className="flex h-full w-11 items-center justify-center text-[var(--text-muted)] hover:bg-[var(--background-elevated)] transition-colors"
          aria-label="Minimize"
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          onClick={() => window.api.window.maximize()}
          className="flex h-full w-11 items-center justify-center text-[var(--text-muted)] hover:bg-[var(--background-elevated)] transition-colors"
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <Copy size={12} className="rotate-180" /> : <Square size={12} />}
        </button>
        <button
          type="button"
          onClick={() => window.api.window.close()}
          className="flex h-full w-11 items-center justify-center text-[var(--text-muted)] hover:bg-red-500 hover:text-white transition-colors"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
