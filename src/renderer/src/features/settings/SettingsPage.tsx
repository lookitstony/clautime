import { useState, useCallback, useEffect, type ChangeEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useDetectGitIdentity, useSetGitIdentity } from '../git/use-git'

const ACCENT_THEMES = [
  { id: 'teal', color: '#14b8a6', label: 'Teal' },
  { id: 'amber', color: '#f59e0b', label: 'Amber' },
  { id: 'purple', color: '#a78bfa', label: 'Purple' },
  { id: 'blue', color: '#3b82f6', label: 'Blue' }
] as const

function SectionHeader({ title }: { title: string }): React.JSX.Element {
  return (
    <h2 className="mb-3 text-[14px] font-semibold text-[var(--text-primary)]">{title}</h2>
  )
}

function SectionCard({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-4">
      {children}
    </div>
  )
}

export function SettingsPage(): React.JSX.Element {
  const queryClient = useQueryClient()
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    window.api.updater.getVersion().then((r) => {
      if (r.success) setAppVersion(r.data)
    })
  }, [])

  // ============= AI Configuration =============
  const { data: hasKey } = useQuery({
    queryKey: ['ai', 'hasKey'],
    queryFn: async () => {
      const r = await window.api.ai.hasApiKey()
      return r.success ? r.data : false
    }
  })

  const [apiKeyInput, setApiKeyInput] = useState('')
  const [testResult, setTestResult] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')

  const storeKey = useMutation({
    mutationFn: async (key: string) => {
      const r = await window.api.ai.storeApiKey(key)
      if (!r.success) throw new Error(r.error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai'] })
      setApiKeyInput('')
      toast.success('API key saved securely')
    }
  })

  const removeKey = useMutation({
    mutationFn: async () => {
      const r = await window.api.ai.removeApiKey()
      if (!r.success) throw new Error(r.error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai'] })
      toast.success('API key removed')
    }
  })

  const testConnection = useCallback(async () => {
    setTestResult('testing')
    const r = await window.api.ai.testConnection()
    setTestResult(r.success && r.data ? 'success' : 'error')
  }, [])

  // ============= Git Identity =============
  const { data: detectedIdentity } = useDetectGitIdentity()
  const setGitIdentity = useSetGitIdentity()

  const [gitName, setGitName] = useState('')
  const [gitEmail, setGitEmail] = useState('')

  // Load settings values
  const { data: settings } = useQuery({
    queryKey: ['settings', 'all'],
    queryFn: async () => {
      const r = await window.api.settings.getAll()
      return r.success ? r.data : {}
    }
  })

  useEffect(() => {
    if (settings) {
      setGitName(settings['git_author_name'] ?? detectedIdentity?.name ?? '')
      setGitEmail(settings['git_author_email'] ?? detectedIdentity?.email ?? '')
    }
  }, [settings, detectedIdentity])

  const saveGitIdentity = useCallback(() => {
    if (!gitName || !gitEmail) return
    setGitIdentity.mutate({ name: gitName, email: gitEmail })
  }, [gitName, gitEmail, setGitIdentity])

  // ============= Session Detection =============
  const [idleTimeout, setIdleTimeout] = useState(15)
  const [claudeDir, setClaudeDir] = useState('')

  useEffect(() => {
    if (settings) {
      const timeout = settings['idle_timeout_minutes']
      if (timeout) setIdleTimeout(parseInt(timeout, 10) || 15)
      setClaudeDir(settings['claude_dir'] ?? '')
    }
  }, [settings])

  const saveSetting = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const r = await window.api.settings.set(key, value)
      if (!r.success) throw new Error(r.error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success('Settings saved')
    }
  })

  const handleBrowseClaudeDir = useCallback(async () => {
    const r = await window.api.dialog.openFolder()
    if (r.success && r.data) {
      setClaudeDir(r.data)
      saveSetting.mutate({ key: 'claude_dir', value: r.data })
    }
  }, [saveSetting])

  // ============= After Hours Mode =============
  const afterHoursMode = settings?.['after_hours_mode'] === 'true'

  // ============= Theme =============
  const currentAccent = settings?.['accent_theme'] ?? 'teal'

  const setAccent = useCallback(
    (id: string) => {
      document.documentElement.setAttribute('data-accent', id)
      saveSetting.mutate({ key: 'accent_theme', value: id })
    },
    [saveSetting]
  )

  // Apply accent on load
  useEffect(() => {
    if (currentAccent) {
      document.documentElement.setAttribute('data-accent', currentAccent)
    }
  }, [currentAccent])

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-[18px] font-bold text-[var(--text-primary)]">Settings</h1>

      {/* AI Configuration */}
      <section>
        <SectionHeader title="AI Configuration" />
        <SectionCard>
          <p className="mb-3 text-[12px] text-[var(--text-muted)]">
            Add an Anthropic API key to enable AI-powered summaries when exporting reports.
            Without a key, you can still generate work summaries from git commits.
          </p>
          <div className="space-y-2">
            <label className="text-[12px] font-semibold text-[var(--text-muted)]">
              Anthropic API Key
            </label>
            {hasKey ? (
              <div className="flex items-center gap-2">
                <span className="font-mono text-[13px] text-[var(--text-secondary)]">
                  sk-•••••••••••••••
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={testConnection}
                  className="text-[11px]"
                >
                  {testResult === 'testing' ? 'Testing...' : 'Test Connection'}
                </Button>
                {testResult === 'success' && (
                  <span className="text-[11px] text-[var(--accent)]">Valid</span>
                )}
                {testResult === 'error' && (
                  <span className="text-[11px] text-[var(--destructive)]">Invalid</span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm('Remove your API key? You will need to re-enter it to use AI features.')) {
                      removeKey.mutate()
                    }
                  }}
                  className="text-[11px] text-[var(--destructive)]"
                >
                  Remove
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setApiKeyInput(e.target.value)}
                  placeholder="sk-ant-..."
                  className="flex-1 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 font-mono text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
                <Button
                  size="sm"
                  onClick={() => apiKeyInput && storeKey.mutate(apiKeyInput)}
                  disabled={!apiKeyInput}
                  className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
                >
                  Save Key
                </Button>
              </div>
            )}
          </div>
        </SectionCard>
      </section>

      {/* Git Identity */}
      <section>
        <SectionHeader title="Git Identity" />
        <SectionCard>
          <p className="mb-3 text-[12px] text-[var(--text-muted)]">
            Used to filter commits to only your own. Auto-detected from git config.
          </p>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-[12px] font-semibold text-[var(--text-muted)]">
                Name
              </label>
              <input
                type="text"
                value={gitName}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setGitName(e.target.value)}
                placeholder="Your Name"
                className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-[12px] font-semibold text-[var(--text-muted)]">
                Email
              </label>
              <input
                type="text"
                value={gitEmail}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setGitEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </div>
          </div>
          <Button
            size="sm"
            onClick={saveGitIdentity}
            disabled={!gitName || !gitEmail}
            className="mt-3 bg-[var(--accent)] text-white hover:brightness-[1.15]"
          >
            Save Identity
          </Button>
        </SectionCard>
      </section>

      {/* Session Detection */}
      <section>
        <SectionHeader title="Session Detection" />
        <SectionCard>
          <div className="mb-4">
            <label className="mb-1 block text-[12px] font-semibold text-[var(--text-muted)]">
              Idle Timeout (minutes)
            </label>
            <p className="mb-2 text-[11px] text-[var(--text-muted)]">
              Sessions are split when there&apos;s a gap longer than this between messages.
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={60}
                value={idleTimeout}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setIdleTimeout(parseInt(e.target.value, 10))}
                onMouseUp={() => saveSetting.mutate({ key: 'idle_timeout_minutes', value: String(idleTimeout) })}
                onTouchEnd={() => saveSetting.mutate({ key: 'idle_timeout_minutes', value: String(idleTimeout) })}
                className="flex-1"
              />
              <span className="w-12 text-right font-mono text-[13px] text-[var(--text-primary)]">
                {idleTimeout}m
              </span>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[12px] font-semibold text-[var(--text-muted)]">
              Claude Directory
            </label>
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 font-mono text-[12px] text-[var(--text-secondary)]">
                {claudeDir || '~/.claude (default)'}
              </span>
              <Button size="sm" variant="ghost" onClick={handleBrowseClaudeDir}>
                Browse
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-muted)]">
                After Hours Mode
              </label>
              <p className="text-[11px] text-[var(--text-muted)]">
                Hide sessions between 7 AM – 6 PM in Sessions and Reports.
              </p>
            </div>
            <Switch
              checked={afterHoursMode}
              onCheckedChange={(checked) =>
                saveSetting.mutate({ key: 'after_hours_mode', value: checked ? 'true' : 'false' })
              }
            />
          </div>
        </SectionCard>
      </section>

      {/* Appearance */}
      <section>
        <SectionHeader title="Appearance" />
        <SectionCard>
          <label className="mb-2 block text-[12px] font-semibold text-[var(--text-muted)]">
            Accent Color
          </label>
          <div className="flex gap-3">
            {ACCENT_THEMES.map((theme) => (
              <button
                key={theme.id}
                type="button"
                onClick={() => setAccent(theme.id)}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all',
                  currentAccent === theme.id
                    ? 'border-[var(--text-primary)] scale-110'
                    : 'border-transparent hover:scale-105'
                )}
                style={{ backgroundColor: theme.color }}
                title={theme.label}
              >
                {currentAccent === theme.id && (
                  <span className="text-[14px] text-white">✓</span>
                )}
              </button>
            ))}
          </div>
        </SectionCard>
      </section>

      {/* App Info */}
      <section>
        <SectionCard>
          <div className="flex items-center justify-between text-[12px] text-[var(--text-muted)]">
            <span>ClawdTime v{appVersion ?? '0.1.0'}</span>
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => {
                  window.api.updater.checkForUpdates()
                  toast.info('Checking for updates...')
                }}
              >
                Check for Updates
              </Button>
              <span>Built with Electron + React + Vite</span>
            </div>
          </div>
        </SectionCard>
      </section>
    </div>
  )
}
