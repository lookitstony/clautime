import { useState, useCallback, useEffect, useRef, type ChangeEvent } from 'react'
import { toast } from 'sonner'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Volume2, VolumeX, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
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
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

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
  const [savedIdleTimeout, setSavedIdleTimeout] = useState(15)
  const [claudeDir, setClaudeDir] = useState('')
  const [alertMode, setAlertMode] = useState<'percent' | 'minutes'>('percent')
  const [alertMinutes, setAlertMinutes] = useState(5)
  const [isSavingIdle, setIsSavingIdle] = useState(false)

  useEffect(() => {
    if (settings) {
      const timeout = settings['idle_timeout_minutes']
      const val = timeout ? parseInt(timeout, 10) || 15 : 15
      setIdleTimeout(val)
      setSavedIdleTimeout(val)
      setClaudeDir(settings['claude_dir'] ?? '')
      setAlertMode((settings['alert_threshold_mode'] as 'percent' | 'minutes') ?? 'percent')
      const am = settings['alert_threshold_minutes']
      if (am) setAlertMinutes(parseInt(am, 10) || 5)
    }
  }, [settings])

  const idleTimeoutChanged = idleTimeout !== savedIdleTimeout

  const saveIdleTimeoutAndRebuild = useCallback(async () => {
    setIsSavingIdle(true)
    try {
      await window.api.settings.set('idle_timeout_minutes', String(idleTimeout))
      await window.api.sessions.scanAndRebuild()
      setSavedIdleTimeout(idleTimeout)
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      queryClient.invalidateQueries({ queryKey: ['live'] })
      toast.success('Idle timeout saved — sessions rebuilt')
    } catch {
      toast.error('Failed to save and rebuild')
    } finally {
      setIsSavingIdle(false)
    }
  }, [idleTimeout, queryClient])

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

  // ============= Notification Volume =============
  const [notifVolume, setNotifVolume] = useState(50)
  const volumeInitialized = useRef(false)

  useEffect(() => {
    if (settings && !volumeInitialized.current) {
      const vol = settings['notification_volume']
      if (vol != null) setNotifVolume(parseInt(vol, 10) || 50)
      volumeInitialized.current = true
    }
  }, [settings])

  // ============= Reset =============
  const [isResetting, setIsResetting] = useState(false)

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
                  onClick={() => setConfirmRemoveKey(true)}
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
              Max time between prompts before a new session starts. Covers reading responses, testing, and thinking.
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={15}
                value={idleTimeout}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setIdleTimeout(parseInt(e.target.value, 10))}
                className="flex-1"
              />
              <span className="w-12 text-right font-mono text-[13px] text-[var(--text-primary)]">
                {idleTimeout}m
              </span>
              {idleTimeoutChanged && (
                <Button
                  size="sm"
                  disabled={isSavingIdle}
                  className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
                  onClick={saveIdleTimeoutAndRebuild}
                >
                  {isSavingIdle && <LoaderCircle size={14} className="mr-1 animate-spin" />}
                  {isSavingIdle ? 'Rebuilding...' : 'Save & Rebuild'}
                </Button>
              )}
            </div>
          </div>

          <div className="mb-4">
            <label className="mb-1 block text-[12px] font-semibold text-[var(--text-muted)]">
              Widget Alert Threshold
            </label>
            <p className="mb-2 text-[11px] text-[var(--text-muted)]">
              When the widget border transitions from green to yellow (warning).
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setAlertMode('percent')
                  saveSetting.mutate({ key: 'alert_threshold_mode', value: 'percent' })
                }}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors',
                  alertMode === 'percent'
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                    : 'border-[var(--surface-border)] text-[var(--text-secondary)] hover:bg-[var(--surface-border)]/30'
                )}
              >
                75% of idle time
              </button>
              <button
                type="button"
                onClick={() => {
                  setAlertMode('minutes')
                  saveSetting.mutate({ key: 'alert_threshold_mode', value: 'minutes' })
                }}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors',
                  alertMode === 'minutes'
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                    : 'border-[var(--surface-border)] text-[var(--text-secondary)] hover:bg-[var(--surface-border)]/30'
                )}
              >
                Fixed minutes
              </button>
              {alertMode === 'minutes' && (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={120}
                    value={alertMinutes}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setAlertMinutes(parseInt(e.target.value, 10) || 1)}
                    onBlur={() => saveSetting.mutate({ key: 'alert_threshold_minutes', value: String(alertMinutes) })}
                    className="w-16 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-2 py-1 text-center font-mono text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                  />
                  <span className="text-[12px] text-[var(--text-muted)]">min</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-muted)]">
                Widget Glow Effect
              </label>
              <p className="text-[11px] text-[var(--text-muted)]">
                Animated glow around floating widgets indicating activity status.
              </p>
            </div>
            <Switch
              checked={settings?.['widget_glow_enabled'] !== 'false'}
              onCheckedChange={(checked) =>
                saveSetting.mutate({ key: 'widget_glow_enabled', value: checked ? 'true' : 'false' })
              }
            />
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

          <div className="flex items-center justify-between border-t border-[var(--surface-border)] pt-3 mt-3">
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-muted)]">
                Reset Sessions
              </label>
              <p className="text-[11px] text-[var(--text-muted)]">
                Clear all session data and re-scan from JSONL files.
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={isResetting}
              className="text-[11px] text-red-400 hover:text-red-400 hover:bg-red-500/15"
              onClick={() => setConfirmReset(true)}
            >
              {isResetting && <LoaderCircle size={14} className="mr-1 animate-spin" />}
              {isResetting ? 'Rescanning...' : 'Reset & Rescan'}
            </Button>
          </div>
        </SectionCard>
      </section>

      {/* Notifications */}
      <section>
        <SectionHeader title="Notifications" />
        <SectionCard>
          <div className="flex items-center justify-between mb-4">
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-muted)]">
                Desktop Alerts
              </label>
              <p className="text-[11px] text-[var(--text-muted)]">
                Show desktop notifications when a watched project is idle.
              </p>
            </div>
            <Switch
              checked={settings?.['desktop_alerts_enabled'] !== 'false'}
              onCheckedChange={(checked) =>
                saveSetting.mutate({ key: 'desktop_alerts_enabled', value: checked ? 'true' : 'false' })
              }
            />
          </div>

          <div>
            <label className="mb-1 block text-[12px] font-semibold text-[var(--text-muted)]">
              Alert Volume
            </label>
            <p className="mb-2 text-[11px] text-[var(--text-muted)]">
              Volume for idle prompt alert sounds.
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  const newVal = notifVolume === 0 ? 50 : 0
                  setNotifVolume(newVal)
                  saveSetting.mutate({ key: 'notification_volume', value: String(newVal) }, {
                    onSuccess: () => { if (newVal > 0) window.api.live.playTestSound() }
                  })
                }}
                className="rounded p-1 transition-colors hover:bg-[var(--surface-border)]/50"
                aria-label={notifVolume === 0 ? 'Unmute' : 'Mute'}
              >
                {notifVolume === 0 ? (
                  <VolumeX size={18} className="text-red-400" />
                ) : (
                  <Volume2 size={18} className="text-[var(--text-secondary)]" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={notifVolume}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setNotifVolume(parseInt(e.target.value, 10))}
                onMouseUp={() => saveSetting.mutate({ key: 'notification_volume', value: String(notifVolume) }, {
                  onSuccess: () => { if (notifVolume > 0) window.api.live.playTestSound() }
                })}
                onTouchEnd={() => saveSetting.mutate({ key: 'notification_volume', value: String(notifVolume) }, {
                  onSuccess: () => { if (notifVolume > 0) window.api.live.playTestSound() }
                })}
                className="flex-1"
              />
              <span className="w-12 text-right font-mono text-[13px] text-[var(--text-primary)]">
                {notifVolume === 0 ? 'Mute' : `${notifVolume}%`}
              </span>
            </div>
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

      <ConfirmDialog
        open={confirmRemoveKey}
        title="Remove API Key"
        description="Remove your API key? You will need to re-enter it to use AI features."
        confirmLabel="Remove"
        cancelLabel="Keep"
        variant="destructive"
        onConfirm={() => {
          setConfirmRemoveKey(false)
          removeKey.mutate()
        }}
        onCancel={() => setConfirmRemoveKey(false)}
      />

      <ConfirmDialog
        open={confirmReset}
        title="Reset Sessions"
        description="This will delete ALL data including raw message history and re-import from scratch. Any history from compacted conversations will be permanently lost. This cannot be undone."
        confirmLabel="Reset & Rescan"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={async () => {
          setConfirmReset(false)
          setIsResetting(true)
          try {
            await window.api.sessions.reset()
            await window.api.sessions.scan()
            queryClient.invalidateQueries({ queryKey: ['sessions'] })
            queryClient.invalidateQueries({ queryKey: ['live'] })
            queryClient.invalidateQueries({ queryKey: ['git'] })
            toast.success('Sessions reset and re-scanned')
          } catch {
            toast.error('Reset failed')
          } finally {
            setIsResetting(false)
          }
        }}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  )
}
