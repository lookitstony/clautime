import { useState, useCallback, useEffect, useRef, type ChangeEvent } from 'react'
import { toast } from 'sonner'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Volume2,
  VolumeX,
  LoaderCircle,
  Shield,
  X,
  Plus,
  Trash2,
  FlaskConical,
  AlertTriangle,
  Pencil,
  RotateCcw
} from 'lucide-react'
import type { CustomSecretPattern, PatternTestResult } from '../../../../shared/types/secret-scan'
import {
  DEFAULT_AI_SUMMARY_INSTRUCTIONS,
  DEFAULT_AI_BRIEF_INSTRUCTIONS
} from '../../../../shared/constants'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn } from '@/lib/utils'

const ACCENT_THEMES = [
  { id: 'teal', color: '#14b8a6', label: 'Teal' },
  { id: 'amber', color: '#f59e0b', label: 'Amber' },
  { id: 'purple', color: '#a78bfa', label: 'Purple' },
  { id: 'blue', color: '#3b82f6', label: 'Blue' }
] as const

function SectionHeader({ title }: { title: string }): React.JSX.Element {
  return <h2 className="mb-3 text-[14px] font-semibold text-[var(--text-primary)]">{title}</h2>
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
  const userTriggeredCheck = useRef(false)

  useEffect(() => {
    window.api.updater.getVersion().then((r) => {
      if (r.success) setAppVersion(r.data)
    })

    window.api.updater.onUpdateAvailable((info) => {
      userTriggeredCheck.current = false
      toast.success(`Update available: v${info.version}`, {
        duration: 10_000,
        action: {
          label: 'Download',
          onClick: () => {
            window.api.updater.downloadAndInstall()
            toast.info('Downloading update…')
          }
        }
      })
    })

    window.api.updater.onUpdateNotAvailable(() => {
      if (userTriggeredCheck.current) {
        userTriggeredCheck.current = false
        toast.success("You're on the latest version")
      }
    })

    window.api.updater.onUpdateDownloaded(() => {
      toast.success('Update ready — restart to apply', {
        duration: 15_000,
        action: {
          label: 'Restart',
          onClick: () => window.api.updater.downloadAndInstall()
        }
      })
    })

    window.api.updater.onUpdateError((info) => {
      if (userTriggeredCheck.current) {
        userTriggeredCheck.current = false
        toast.error(`Update check failed: ${info.message}`)
      }
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
  const [aiInstructions, setAiInstructions] = useState(DEFAULT_AI_SUMMARY_INSTRUCTIONS)
  const [savedAiInstructions, setSavedAiInstructions] = useState(DEFAULT_AI_SUMMARY_INSTRUCTIONS)
  const [showAiInstructions, setShowAiInstructions] = useState(false)
  const [aiBriefInstructions, setAiBriefInstructions] = useState(DEFAULT_AI_BRIEF_INSTRUCTIONS)
  const [savedAiBriefInstructions, setSavedAiBriefInstructions] = useState(
    DEFAULT_AI_BRIEF_INSTRUCTIONS
  )
  const [showAiBriefInstructions, setShowAiBriefInstructions] = useState(false)

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

  // ============= Stripe Configuration =============
  const { data: stripeMode = 'live' } = useQuery({
    queryKey: ['stripe', 'mode'],
    queryFn: async () => {
      const r = await window.api.invoice.getStripeMode()
      return r.success ? r.data : ('live' as const)
    }
  })

  const { data: hasStripeLiveKey = false } = useQuery({
    queryKey: ['stripe', 'hasKey', 'live'],
    queryFn: async () => {
      const r = await window.api.invoice.hasStripeKeyForMode('live')
      return r.success ? r.data : false
    }
  })

  const { data: hasStripeTestKey = false } = useQuery({
    queryKey: ['stripe', 'hasKey', 'test'],
    queryFn: async () => {
      const r = await window.api.invoice.hasStripeKeyForMode('test')
      return r.success ? r.data : false
    }
  })

  const hasStripeKey = stripeMode === 'test' ? hasStripeTestKey : hasStripeLiveKey
  const isStripeTestMode = stripeMode === 'test'

  const { data: stripeTestEmail = '' } = useQuery({
    queryKey: ['stripe', 'testEmail'],
    queryFn: async () => {
      const r = await window.api.invoice.getStripeTestEmail()
      return r.success ? (r.data ?? '') : ''
    }
  })
  const [testEmailInput, setTestEmailInput] = useState('')
  const [testEmailDirty, setTestEmailDirty] = useState(false)
  useEffect(() => {
    if (stripeTestEmail && !testEmailDirty) {
      setTestEmailInput(stripeTestEmail)
    }
  }, [stripeTestEmail, testEmailDirty])

  const saveTestEmail = useMutation({
    mutationFn: async (email: string) => {
      const r = await window.api.invoice.setStripeTestEmail(email)
      if (!r.success) throw new Error(r.error.message)
    },
    onSuccess: () => {
      setTestEmailDirty(false)
      queryClient.invalidateQueries({ queryKey: ['stripe', 'testEmail'] })
      toast.success('Test email saved')
    },
    onError: (err) => {
      toast.error(`Failed to save test email: ${err.message}`)
    }
  })

  const [stripeKeyInput, setStripeKeyInput] = useState('')
  const [stripeTestResult, setStripeTestResult] = useState<
    'idle' | 'testing' | 'success' | 'error'
  >('idle')
  const [confirmRemoveStripeKey, setConfirmRemoveStripeKey] = useState(false)

  const storeStripeKey = useMutation({
    mutationFn: async (key: string) => {
      const r = await window.api.invoice.storeStripeKey(key)
      if (!r.success) throw new Error(r.error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stripe'] })
      setStripeKeyInput('')
      toast.success('Stripe API key saved securely')
    }
  })

  const removeStripeKey = useMutation({
    mutationFn: async (mode: 'live' | 'test') => {
      const r = await window.api.invoice.removeStripeKeyForMode(mode)
      if (!r.success) throw new Error(r.error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stripe'] })
      toast.success('Stripe API key removed')
    }
  })

  const setStripeMode = useMutation({
    mutationFn: async (mode: 'live' | 'test') => {
      const r = await window.api.invoice.setStripeMode(mode)
      if (!r.success) throw new Error(r.error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stripe'] })
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      setStripeTestResult('idle')
    }
  })

  const testStripeConnection = useCallback(async () => {
    setStripeTestResult('testing')
    const r = await window.api.invoice.testConnection()
    setStripeTestResult(r.success && r.data ? 'success' : 'error')
  }, [])

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
      const saved = settings['ai_summary_instructions']
      if (saved) {
        setAiInstructions(saved)
        setSavedAiInstructions(saved)
      }
      const savedBrief = settings['ai_brief_instructions']
      if (savedBrief) {
        setAiBriefInstructions(savedBrief)
        setSavedAiBriefInstructions(savedBrief)
      }
    }
  }, [settings])

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
      if (settings['widget_toggle_hotkey']) setWidgetHotkey(settings['widget_toggle_hotkey'])
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

  // ============= Secret Scanner =============
  const [scanMode, setScanMode] = useState<'monitor' | 'monitor-alert' | 'auto-clean'>('monitor')
  const [isScanRunning, setIsScanRunning] = useState(false)
  const [isRedacting, setIsRedacting] = useState(false)
  const [widgetHotkey, setWidgetHotkey] = useState('Ctrl+Shift+H')
  const [isRecordingHotkey, setIsRecordingHotkey] = useState(false)
  const [showFindings, setShowFindings] = useState(false)

  useEffect(() => {
    if (settings) {
      const mode = settings['secret_scan_mode'] as 'monitor' | 'monitor-alert' | 'auto-clean'
      if (mode) setScanMode(mode)
    }
  }, [settings])

  const { data: scanSummary, refetch: refetchSummary } = useQuery({
    queryKey: ['secretScan', 'summary'],
    queryFn: async () => {
      const r = await window.api.secretScan.getSummary()
      return r.success ? r.data : null
    }
  })

  const { data: scanFindings, refetch: refetchFindings } = useQuery({
    queryKey: ['secretScan', 'findings'],
    queryFn: async () => {
      const r = await window.api.secretScan.getFindings()
      return r.success ? r.data : []
    },
    enabled: showFindings
  })

  const lastScanDate = settings?.['secret_scan_last_date']

  const handleScanNow = useCallback(async () => {
    setIsScanRunning(true)
    try {
      const r = await window.api.secretScan.run()
      if (r.success) {
        const d = r.data
        const summaryR = await window.api.secretScan.getSummary()
        const unresolved = summaryR.success ? summaryR.data.found : 0
        toast.success(
          `Scan completed: ${d.filesScanned} files scanned, ${d.newFindings} new findings, ${unresolved} unresolved findings.`
        )
        refetchSummary()
        refetchFindings()
        queryClient.invalidateQueries({ queryKey: ['settings'] })
      } else {
        toast.error(`Scan failed: ${r.error?.message ?? 'unknown error'}`)
      }
    } catch (err) {
      toast.error(`Scan failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsScanRunning(false)
    }
  }, [refetchSummary, refetchFindings, queryClient])

  const handleIgnoreFinding = useCallback(
    async (id: number) => {
      const r = await window.api.secretScan.ignoreFinding(id)
      if (!r.success) {
        toast.error('Failed to ignore finding')
        return
      }
      refetchFindings()
      refetchSummary()
    },
    [refetchFindings, refetchSummary]
  )

  const handleRedactFinding = useCallback(
    async (id: number) => {
      const r = await window.api.secretScan.redactFinding(id)
      if (!r.success) {
        toast.error('Failed to redact finding')
        return
      }
      refetchFindings()
      refetchSummary()
    },
    [refetchFindings, refetchSummary]
  )

  const handleRedactAll = useCallback(async () => {
    setIsRedacting(true)
    try {
      const r = await window.api.secretScan.redactAll()
      if (r.success) {
        toast.success(`Redacted ${r.data} finding${r.data === 1 ? '' : 's'}`)
        refetchFindings()
        refetchSummary()
      }
    } finally {
      setIsRedacting(false)
    }
  }, [refetchFindings, refetchSummary])

  // ============= Custom Patterns =============
  const [showCustomPatterns, setShowCustomPatterns] = useState(false)
  const [editingPattern, setEditingPattern] = useState<CustomSecretPattern | null>(null)
  const [patternForm, setPatternForm] = useState({
    label: '',
    source: '',
    flags: '',
    severity: 'high' as 'critical' | 'high' | 'medium',
    redactLabel: ''
  })
  const [testString, setTestString] = useState('')
  const [patternTestResult, setPatternTestResult] = useState<PatternTestResult | null>(null)
  const [patternWarnings, setPatternWarnings] = useState<string[]>([])
  const [confirmDeletePattern, setConfirmDeletePattern] = useState<string | null>(null)

  const { data: customPatterns, refetch: refetchCustomPatterns } = useQuery({
    queryKey: ['secretScan', 'customPatterns'],
    queryFn: async () => {
      const r = await window.api.secretScan.getCustomPatterns()
      return r.success ? r.data : []
    }
  })

  const resetPatternForm = useCallback(() => {
    setEditingPattern(null)
    setPatternForm({ label: '', source: '', flags: '', severity: 'high', redactLabel: '' })
    setTestString('')
    setPatternTestResult(null)
    setPatternWarnings([])
  }, [])

  const startEditPattern = useCallback((p: CustomSecretPattern) => {
    setEditingPattern(p)
    setPatternForm({
      label: p.label,
      source: p.source,
      flags: p.flags,
      severity: p.severity,
      redactLabel: p.redactLabel
    })
    setTestString('')
    setPatternTestResult(null)
    setPatternWarnings([])
  }, [])

  const handleTestPattern = useCallback(async () => {
    if (!patternForm.source) return
    const r = await window.api.secretScan.testPattern(
      patternForm.source,
      patternForm.flags,
      testString
    )
    if (r.success) {
      setPatternTestResult(r.data)
      setPatternWarnings(r.data.warnings)
    } else {
      setPatternWarnings([r.error?.message ?? 'Test failed'])
    }
  }, [patternForm.source, patternForm.flags, testString])

  const handleSavePattern = useCallback(async () => {
    if (!patternForm.label || !patternForm.source) {
      toast.error('Label and regex pattern are required')
      return
    }
    const id =
      editingPattern?.id ??
      patternForm.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    const pattern: CustomSecretPattern = {
      id,
      label: patternForm.label,
      source: patternForm.source,
      flags: patternForm.flags,
      severity: patternForm.severity,
      redactLabel: patternForm.redactLabel || `REDACTED-${id}`,
      enabled: editingPattern?.enabled ?? true
    }
    const r = await window.api.secretScan.upsertCustomPattern(pattern)
    if (r.success) {
      if (r.data.success) {
        toast.success(editingPattern ? 'Pattern updated' : 'Pattern added')
        if (r.data.warnings.length > 0) {
          setPatternWarnings(r.data.warnings)
        } else {
          resetPatternForm()
        }
        refetchCustomPatterns()
      } else {
        setPatternWarnings(r.data.warnings)
      }
    }
  }, [patternForm, editingPattern, resetPatternForm, refetchCustomPatterns])

  const handleDeletePattern = useCallback(
    async (id: string) => {
      await window.api.secretScan.deleteCustomPattern(id)
      refetchCustomPatterns()
      toast.success('Pattern deleted')
      setConfirmDeletePattern(null)
    },
    [refetchCustomPatterns]
  )

  const handleTogglePattern = useCallback(
    async (pattern: CustomSecretPattern) => {
      await window.api.secretScan.upsertCustomPattern({ ...pattern, enabled: !pattern.enabled })
      refetchCustomPatterns()
    },
    [refetchCustomPatterns]
  )

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
            Add an Anthropic API key to enable AI-powered summaries when exporting reports. Without
            a key, you can still generate work summaries from git commits.
          </p>
          <div className="space-y-2">
            <label className="text-[12px] font-semibold text-[var(--text-primary)]">
              Anthropic API Key
            </label>
            {hasKey ? (
              <div className="flex items-center gap-2">
                <span className="font-mono text-[13px] text-[var(--text-secondary)]">
                  sk-•••••••••••••••
                </span>
                <Button size="sm" variant="ghost" onClick={testConnection} className="text-[11px]">
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

        <SectionCard>
          <div className="flex items-center justify-between">
            <label className="text-[12px] font-semibold text-[var(--text-primary)]">
              AI Summary Instructions
            </label>
            <div className="flex gap-1">
              {showAiInstructions && aiInstructions !== savedAiInstructions && (
                <Button
                  size="sm"
                  onClick={() => {
                    saveSetting.mutate({ key: 'ai_summary_instructions', value: aiInstructions })
                    setSavedAiInstructions(aiInstructions)
                  }}
                  className="h-6 bg-[var(--accent)] px-2 text-[11px] text-white hover:brightness-[1.15]"
                >
                  Save
                </Button>
              )}
              {showAiInstructions && aiInstructions !== DEFAULT_AI_SUMMARY_INSTRUCTIONS && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAiInstructions(DEFAULT_AI_SUMMARY_INSTRUCTIONS)
                    saveSetting.mutate({
                      key: 'ai_summary_instructions',
                      value: DEFAULT_AI_SUMMARY_INSTRUCTIONS
                    })
                    setSavedAiInstructions(DEFAULT_AI_SUMMARY_INSTRUCTIONS)
                    toast.success('Reset to default instructions')
                  }}
                  className="h-6 px-2 text-[11px]"
                >
                  <RotateCcw className="mr-1 h-3 w-3" />
                  Reset
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowAiInstructions(!showAiInstructions)}
                className="h-6 px-2 text-[11px]"
              >
                {showAiInstructions ? 'Hide' : 'Configure'}
              </Button>
            </div>
          </div>
          {showAiInstructions && (
            <>
              <p className="mt-2 mb-2 text-[11px] text-[var(--text-muted)]">
                Customize the prompt used when generating AI work summaries. Commit data and section
                formatting are added automatically — these instructions control tone and style.
              </p>
              <textarea
                value={aiInstructions}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                  setAiInstructions(e.target.value)
                }
                rows={8}
                className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </>
          )}
        </SectionCard>

        <SectionCard>
          <div className="flex items-center justify-between">
            <label className="text-[12px] font-semibold text-[var(--text-primary)]">
              AI Brief Instructions
            </label>
            <div className="flex gap-1">
              {showAiBriefInstructions && aiBriefInstructions !== savedAiBriefInstructions && (
                <Button
                  size="sm"
                  onClick={() => {
                    saveSetting.mutate({ key: 'ai_brief_instructions', value: aiBriefInstructions })
                    setSavedAiBriefInstructions(aiBriefInstructions)
                  }}
                  className="h-6 bg-[var(--accent)] px-2 text-[11px] text-white hover:brightness-[1.15]"
                >
                  Save
                </Button>
              )}
              {showAiBriefInstructions && aiBriefInstructions !== DEFAULT_AI_BRIEF_INSTRUCTIONS && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAiBriefInstructions(DEFAULT_AI_BRIEF_INSTRUCTIONS)
                    saveSetting.mutate({
                      key: 'ai_brief_instructions',
                      value: DEFAULT_AI_BRIEF_INSTRUCTIONS
                    })
                    setSavedAiBriefInstructions(DEFAULT_AI_BRIEF_INSTRUCTIONS)
                    toast.success('Reset to default brief instructions')
                  }}
                  className="h-6 px-2 text-[11px]"
                >
                  <RotateCcw className="mr-1 h-3 w-3" />
                  Reset
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowAiBriefInstructions(!showAiBriefInstructions)}
                className="h-6 px-2 text-[11px]"
              >
                {showAiBriefInstructions ? 'Hide' : 'Configure'}
              </Button>
            </div>
          </div>
          {showAiBriefInstructions && (
            <>
              <p className="mt-2 mb-2 text-[11px] text-[var(--text-muted)]">
                Customize the prompt used when generating brief summaries for timesheets. Controls
                audience, tone, and how work is described to non-technical readers.
              </p>
              <textarea
                value={aiBriefInstructions}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                  setAiBriefInstructions(e.target.value)
                }
                rows={8}
                className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </>
          )}
        </SectionCard>
      </section>

      {/* Stripe Invoicing */}
      <section>
        <SectionHeader title="Invoicing" />
        <SectionCard>
          <p className="mb-3 text-[12px] text-[var(--text-muted)]">
            Add Stripe secret keys to enable invoicing directly from ClauTime. Toggle between live
            and sandbox modes.
          </p>

          {/* Mode Toggle */}
          <div className="mb-4 flex items-center gap-2">
            <label className="text-[12px] font-semibold text-[var(--text-primary)]">Mode</label>
            <div className="flex rounded border border-[var(--surface-border)] overflow-hidden">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setStripeMode.mutate('live')}
                className={cn(
                  'rounded-none px-3 py-1 text-[11px] font-medium',
                  stripeMode === 'live'
                    ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent)]'
                    : 'text-[var(--text-muted)]'
                )}
              >
                Live
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setStripeMode.mutate('test')}
                className={cn(
                  'rounded-none px-3 py-1 text-[11px] font-medium',
                  stripeMode === 'test'
                    ? 'bg-amber-500 text-white hover:bg-amber-500'
                    : 'text-[var(--text-muted)]'
                )}
              >
                Sandbox
              </Button>
            </div>
            {isStripeTestMode && (
              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                TEST MODE
              </span>
            )}
          </div>

          {/* Active Key */}
          <div className="space-y-2">
            <label className="text-[12px] font-semibold text-[var(--text-primary)]">
              {isStripeTestMode ? 'Sandbox' : 'Live'} Secret Key
            </label>
            {hasStripeKey ? (
              <div className="flex items-center gap-2">
                <span className="font-mono text-[13px] text-[var(--text-secondary)]">
                  {isStripeTestMode ? 'sk_test_' : 'sk_live_'}•••••••••••••••
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={testStripeConnection}
                  className="text-[11px]"
                >
                  {stripeTestResult === 'testing' ? 'Testing...' : 'Test Connection'}
                </Button>
                {stripeTestResult === 'success' && (
                  <span className="text-[11px] text-[var(--accent)]">Valid</span>
                )}
                {stripeTestResult === 'error' && (
                  <span className="text-[11px] text-[var(--destructive)]">Invalid</span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmRemoveStripeKey(true)}
                  className="text-[11px] text-[var(--destructive)]"
                >
                  Remove
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={stripeKeyInput}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setStripeKeyInput(e.target.value)}
                  placeholder={isStripeTestMode ? 'sk_test_...' : 'sk_live_...'}
                  className="flex-1 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 font-mono text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
                <Button
                  size="sm"
                  onClick={() => stripeKeyInput && storeStripeKey.mutate(stripeKeyInput)}
                  disabled={
                    !stripeKeyInput ||
                    !stripeKeyInput.startsWith(isStripeTestMode ? 'sk_test_' : 'sk_live_')
                  }
                  className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
                >
                  Save Key
                </Button>
              </div>
            )}
          </div>

          {/* Test Email Override */}
          {isStripeTestMode && (
            <div className="mt-3 space-y-1 border-t border-[var(--surface-border)] pt-3">
              <label className="text-[12px] font-semibold text-[var(--text-primary)]">
                Sandbox Email Override
              </label>
              <p className="text-[11px] text-[var(--text-muted)]">
                In sandbox mode, this email replaces all client emails when creating Stripe
                customers. Keeps real emails out of test data.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="email"
                  value={testEmailInput}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setTestEmailInput(e.target.value)
                    setTestEmailDirty(true)
                  }}
                  placeholder="test@example.com"
                  className="flex-1 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
                <Button
                  size="sm"
                  onClick={() => saveTestEmail.mutate(testEmailInput.trim())}
                  disabled={
                    !testEmailInput.trim() ||
                    testEmailInput.trim() === stripeTestEmail ||
                    saveTestEmail.isPending
                  }
                  className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
                >
                  {saveTestEmail.isPending ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </div>
          )}
        </SectionCard>
      </section>

      {/* Date & Time */}
      <section>
        <SectionHeader title="Date & Time" />
        <SectionCard>
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-[var(--text-primary)]">
              Start of Week
            </label>
            <p className="mb-2 text-[11px] text-[var(--text-muted)]">
              Used for &ldquo;This Week&rdquo; and &ldquo;Last Week&rdquo; filters across sessions,
              reports, and analytics.
            </p>
            <div className="flex gap-1">
              {(
                [
                  { value: '1', label: 'Monday' },
                  { value: '0', label: 'Sunday' },
                  { value: '6', label: 'Saturday' }
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => saveSetting.mutate({ key: 'week_start_day', value: opt.value })}
                  className={cn(
                    'rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors',
                    (settings?.['week_start_day'] ?? '1') === opt.value
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                      : 'border-[var(--surface-border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </SectionCard>
      </section>

      {/* Session Detection */}
      <section>
        <SectionHeader title="Session Detection" />
        <SectionCard>
          <div className="mb-4">
            <label className="mb-1 block text-[12px] font-semibold text-[var(--text-primary)]">
              Human Time Allowance (minutes)
            </label>
            <p className="mb-2 text-[11px] text-[var(--text-muted)]">
              Max time between prompts before a new session starts. Covers reading responses,
              testing, and thinking.
            </p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={15}
                value={idleTimeout}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setIdleTimeout(parseInt(e.target.value, 10))
                }
                className="flex-1"
              />
              <span className="w-12 text-right font-mono text-[13px] text-[var(--text-primary)]">
                {idleTimeout}m
              </span>
              <Button
                size="sm"
                disabled={!idleTimeoutChanged && !isSavingIdle}
                className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
                onClick={saveIdleTimeoutAndRebuild}
              >
                {isSavingIdle && <LoaderCircle size={14} className="mr-1 animate-spin" />}
                {isSavingIdle ? 'Rebuilding...' : 'Save & Rebuild'}
              </Button>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[12px] font-semibold text-[var(--text-primary)]">
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
              <label className="block text-[12px] font-semibold text-[var(--text-primary)]">
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
              <label className="block text-[12px] font-semibold text-[var(--text-primary)]">
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

      {/* Widgets & Notifications */}
      <section>
        <SectionHeader title="Widgets & Notifications" />
        <SectionCard>
          <div className="mb-4">
            <label className="mb-1 block text-[12px] font-semibold text-[var(--text-primary)]">
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
                75% of human time
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
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setAlertMinutes(parseInt(e.target.value, 10) || 1)
                    }
                    onBlur={() =>
                      saveSetting.mutate({
                        key: 'alert_threshold_minutes',
                        value: String(alertMinutes)
                      })
                    }
                    className="w-16 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-2 py-1 text-center font-mono text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                  />
                  <span className="text-[12px] text-[var(--text-muted)]">min</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between mb-4">
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-primary)]">
                Widget Glow Effect
              </label>
              <p className="text-[11px] text-[var(--text-muted)]">
                Animated glow around floating widgets indicating activity status.
              </p>
            </div>
            <Switch
              checked={settings?.['widget_glow_enabled'] !== 'false'}
              onCheckedChange={(checked) =>
                saveSetting.mutate({
                  key: 'widget_glow_enabled',
                  value: checked ? 'true' : 'false'
                })
              }
            />
          </div>

          <div className="flex items-center justify-between mb-4">
            <div>
              <label className="text-[12px] font-semibold text-[var(--text-primary)]">
                Hide Inactive Widgets
              </label>
              <p className="text-[11px] text-[var(--text-muted)]">
                Hide widgets when idle timeout is reached, show them again when activity resumes.
              </p>
            </div>
            <Switch
              checked={settings?.['hide_inactive_widgets'] !== 'false'}
              onCheckedChange={(checked) =>
                saveSetting.mutate({
                  key: 'hide_inactive_widgets',
                  value: checked ? 'true' : 'false'
                })
              }
            />
          </div>

          <div className="mb-4">
            <label className="mb-1 block text-[12px] font-semibold text-[var(--text-primary)]">
              Toggle Widgets Hotkey
            </label>
            <p className="mb-1.5 text-[11px] text-[var(--text-muted)]">
              Global shortcut to hide/show all floating widgets.
            </p>
            <div className="flex items-center gap-2">
              <kbd
                className={cn(
                  'rounded border px-3 py-1.5 font-mono text-[12px]',
                  isRecordingHotkey
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)] animate-pulse'
                    : 'border-[var(--surface-border)] bg-[var(--background-primary)] text-[var(--text-secondary)]'
                )}
              >
                {isRecordingHotkey
                  ? 'Press keys...'
                  : widgetHotkey.replace('CommandOrControl', 'Ctrl')}
              </kbd>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (isRecordingHotkey) {
                    setIsRecordingHotkey(false)
                    return
                  }
                  setIsRecordingHotkey(true)
                  const handler = (e: KeyboardEvent): void => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
                    const parts: string[] = []
                    if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl')
                    if (e.altKey) parts.push('Alt')
                    if (e.shiftKey) parts.push('Shift')
                    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
                    const accelerator = parts.join('+')
                    setWidgetHotkey(accelerator)
                    setIsRecordingHotkey(false)
                    window.removeEventListener('keydown', handler, true)
                    window.api.live.setWidgetHotkey(accelerator).then((r) => {
                      if (r.success)
                        toast.success(
                          `Hotkey set to ${accelerator.replace('CommandOrControl', 'Ctrl')}`
                        )
                      else toast.error('Failed to register hotkey')
                    })
                  }
                  window.addEventListener('keydown', handler, true)
                }}
              >
                {isRecordingHotkey ? 'Cancel' : 'Set'}
              </Button>
            </div>
          </div>

          <div className="border-t border-[var(--surface-border)] pt-3 mt-1">
            <div className="flex items-center justify-between mb-4">
              <div>
                <label className="block text-[12px] font-semibold text-[var(--text-primary)]">
                  Desktop Alerts
                </label>
                <p className="text-[11px] text-[var(--text-muted)]">
                  Show desktop notifications when a watched project is idle.
                </p>
              </div>
              <Switch
                checked={settings?.['desktop_alerts_enabled'] !== 'false'}
                onCheckedChange={(checked) =>
                  saveSetting.mutate({
                    key: 'desktop_alerts_enabled',
                    value: checked ? 'true' : 'false'
                  })
                }
              />
            </div>

            <div>
              <label className="mb-1 block text-[12px] font-semibold text-[var(--text-primary)]">
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
                    saveSetting.mutate(
                      { key: 'notification_volume', value: String(newVal) },
                      {
                        onSuccess: () => {
                          if (newVal > 0) window.api.live.playTestSound()
                        }
                      }
                    )
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
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setNotifVolume(parseInt(e.target.value, 10))
                  }
                  onMouseUp={() =>
                    saveSetting.mutate(
                      { key: 'notification_volume', value: String(notifVolume) },
                      {
                        onSuccess: () => {
                          if (notifVolume > 0) window.api.live.playTestSound()
                        }
                      }
                    )
                  }
                  onTouchEnd={() =>
                    saveSetting.mutate(
                      { key: 'notification_volume', value: String(notifVolume) },
                      {
                        onSuccess: () => {
                          if (notifVolume > 0) window.api.live.playTestSound()
                        }
                      }
                    )
                  }
                  className="flex-1"
                />
                <span className="w-12 text-right font-mono text-[13px] text-[var(--text-primary)]">
                  {notifVolume === 0 ? 'Mute' : `${notifVolume}%`}
                </span>
              </div>
            </div>
          </div>
        </SectionCard>
      </section>

      {/* Privacy & Security */}
      <section>
        <SectionHeader title="Privacy & Security" />
        <SectionCard>
          <p className="mb-3 text-[12px] text-[var(--text-muted)]">
            Scan JSONL conversation files for accidentally exposed secrets like API keys, tokens,
            and passwords.
          </p>

          <div className="mb-4">
            <label className="mb-2 block text-[12px] font-semibold text-[var(--text-primary)]">
              Scan Mode
            </label>
            <div className="flex items-center gap-2">
              {[
                { value: 'monitor' as const, label: 'Monitor' },
                { value: 'monitor-alert' as const, label: 'Monitor & Alert' },
                { value: 'auto-clean' as const, label: 'Auto-Clean' }
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setScanMode(opt.value)
                    saveSetting.mutate({ key: 'secret_scan_mode', value: opt.value })
                  }}
                  className={cn(
                    'rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors',
                    scanMode === opt.value
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                      : 'border-[var(--surface-border)] text-[var(--text-secondary)] hover:bg-[var(--surface-border)]/30'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              {scanMode === 'monitor' && 'Scan and log findings only.'}
              {scanMode === 'monitor-alert' &&
                'Scan, log, and show desktop notification when secrets found.'}
              {scanMode === 'auto-clean' &&
                'Scan and automatically redact detected secrets in-place.'}
            </p>
          </div>

          {scanSummary && scanSummary.total > 0 && (
            <div className="mb-3 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[12px] text-[var(--text-secondary)]">
              <span className="font-medium">
                {scanSummary.total} finding{scanSummary.total === 1 ? '' : 's'}
              </span>
              {' — '}
              {scanSummary.bySeverity.critical > 0 && (
                <span className="text-red-400">{scanSummary.bySeverity.critical} critical</span>
              )}
              {scanSummary.bySeverity.critical > 0 && scanSummary.bySeverity.high > 0 && ', '}
              {scanSummary.bySeverity.high > 0 && (
                <span className="text-amber-400">{scanSummary.bySeverity.high} high</span>
              )}
              {(scanSummary.bySeverity.critical > 0 || scanSummary.bySeverity.high > 0) &&
                scanSummary.bySeverity.medium > 0 &&
                ', '}
              {scanSummary.bySeverity.medium > 0 && (
                <span className="text-yellow-300">{scanSummary.bySeverity.medium} medium</span>
              )}
              {' | '}
              <span>
                {scanSummary.found} active, {scanSummary.redacted} redacted, {scanSummary.ignored}{' '}
                ignored
              </span>
            </div>
          )}

          {lastScanDate && (
            <p className="mb-3 text-[11px] text-[var(--text-muted)]">Last scan: {lastScanDate}</p>
          )}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={isScanRunning}
              className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
              onClick={handleScanNow}
            >
              {isScanRunning && <LoaderCircle size={14} className="mr-1 animate-spin" />}
              {isScanRunning ? 'Scanning...' : 'Scan Now'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowFindings(true)}>
              <Shield size={14} className="mr-1" />
              View Findings
            </Button>
          </div>

          {/* Custom Patterns */}
          <div className="border-t border-[var(--surface-border)] pt-4 mt-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <label className="block text-[12px] font-semibold text-[var(--text-primary)]">
                  Custom Patterns
                </label>
                <p className="text-[11px] text-[var(--text-muted)]">
                  Add your own regex patterns to detect proprietary tokens or secrets.
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  resetPatternForm()
                  setShowCustomPatterns(!showCustomPatterns)
                }}
              >
                {showCustomPatterns ? 'Hide' : 'Manage'}
              </Button>
            </div>

            {/* Existing custom patterns list (always visible if any exist) */}
            {customPatterns && customPatterns.length > 0 && !showCustomPatterns && (
              <div className="space-y-1">
                {customPatterns.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-2 rounded px-2 py-1.5 text-[12px] bg-[var(--background-primary)]"
                  >
                    <Switch
                      checked={p.enabled}
                      onCheckedChange={() => handleTogglePattern(p)}
                      className="scale-75"
                    />
                    <span
                      className={cn(
                        'font-medium',
                        p.enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                      )}
                    >
                      {p.label}
                    </span>
                    <span className="font-mono text-[10px] text-[var(--text-muted)] truncate max-w-[160px]">
                      {p.source}
                    </span>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-medium',
                        p.severity === 'critical' && 'bg-red-500/20 text-red-400',
                        p.severity === 'high' && 'bg-amber-500/20 text-amber-400',
                        p.severity === 'medium' && 'bg-yellow-500/20 text-yellow-300'
                      )}
                    >
                      {p.severity}
                    </span>
                    <div className="ml-auto flex gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          startEditPattern(p)
                          setShowCustomPatterns(true)
                        }}
                        className="flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-border)]/50 hover:text-[var(--text-primary)]"
                      >
                        <Pencil size={12} className="mr-0.5" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeletePattern(p.id)}
                        className="flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-500/15"
                      >
                        <Trash2 size={12} className="mr-0.5" />
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {showCustomPatterns && (
              <div className="space-y-3">
                {/* Pattern list with edit/delete */}
                {customPatterns && customPatterns.length > 0 && (
                  <div className="space-y-1">
                    {customPatterns.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center gap-2 rounded px-2 py-1.5 text-[12px] bg-[var(--background-primary)]"
                      >
                        <Switch
                          checked={p.enabled}
                          onCheckedChange={() => handleTogglePattern(p)}
                          className="scale-75"
                        />
                        <span
                          className={cn(
                            'font-medium',
                            p.enabled ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                          )}
                        >
                          {p.label}
                        </span>
                        <span className="font-mono text-[10px] text-[var(--text-muted)] truncate max-w-[160px]">
                          {p.source}
                        </span>
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[10px] font-medium',
                            p.severity === 'critical' && 'bg-red-500/20 text-red-400',
                            p.severity === 'high' && 'bg-amber-500/20 text-amber-400',
                            p.severity === 'medium' && 'bg-yellow-500/20 text-yellow-300'
                          )}
                        >
                          {p.severity}
                        </span>
                        <div className="ml-auto flex gap-1">
                          <button
                            type="button"
                            onClick={() => startEditPattern(p)}
                            className="flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-border)]/50 hover:text-[var(--text-primary)]"
                          >
                            <Pencil size={12} className="mr-0.5" />
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeletePattern(p.id)}
                            className="flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-500/15"
                          >
                            <Trash2 size={12} className="mr-0.5" />
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add/Edit form */}
                <div className="rounded border border-[var(--surface-border)] bg-[var(--background-primary)] p-3 space-y-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Plus size={14} className="text-[var(--accent)]" />
                    <span className="text-[12px] font-semibold text-[var(--text-primary)]">
                      {editingPattern ? 'Edit Pattern' : 'Add Pattern'}
                    </span>
                    {editingPattern && (
                      <button
                        type="button"
                        onClick={resetPatternForm}
                        className="ml-auto text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      >
                        Cancel Edit
                      </button>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="mb-0.5 block text-[11px] text-[var(--text-muted)]">
                        Label
                      </label>
                      <input
                        type="text"
                        value={patternForm.label}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setPatternForm((f) => ({ ...f, label: e.target.value }))
                        }
                        placeholder="My Internal Token"
                        className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-elevated)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                    <div className="w-24">
                      <label className="mb-0.5 block text-[11px] text-[var(--text-muted)]">
                        Severity
                      </label>
                      <select
                        value={patternForm.severity}
                        onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                          setPatternForm((f) => ({
                            ...f,
                            severity: e.target.value as 'critical' | 'high' | 'medium'
                          }))
                        }
                        className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-elevated)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                      >
                        <option value="critical">Critical</option>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="mb-0.5 block text-[11px] text-[var(--text-muted)]">
                      Regex Pattern{' '}
                      <span className="text-[var(--text-muted)]">(without / delimiters)</span>
                    </label>
                    <input
                      type="text"
                      value={patternForm.source}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        setPatternForm((f) => ({ ...f, source: e.target.value }))
                      }
                      placeholder="mytoken_[a-zA-Z0-9]{32,}"
                      className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-elevated)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                    />
                  </div>

                  <div className="flex gap-2">
                    <div className="w-20">
                      <label className="mb-0.5 block text-[11px] text-[var(--text-muted)]">
                        Flags
                      </label>
                      <input
                        type="text"
                        value={patternForm.flags}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setPatternForm((f) => ({ ...f, flags: e.target.value }))
                        }
                        placeholder="i"
                        className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-elevated)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="mb-0.5 block text-[11px] text-[var(--text-muted)]">
                        Redact Label
                      </label>
                      <input
                        type="text"
                        value={patternForm.redactLabel}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setPatternForm((f) => ({ ...f, redactLabel: e.target.value }))
                        }
                        placeholder="REDACTED-my-token (auto-generated)"
                        className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-elevated)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                  </div>

                  {/* Test area */}
                  <div className="border-t border-[var(--surface-border)] pt-2 mt-1">
                    <label className="mb-0.5 flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                      <FlaskConical size={11} />
                      Test String
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={testString}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setTestString(e.target.value)
                        }
                        placeholder="Paste a sample string to test your regex..."
                        className="flex-1 rounded border border-[var(--surface-border)] bg-[var(--background-elevated)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={handleTestPattern}
                        disabled={!patternForm.source}
                        className="text-[11px]"
                      >
                        <FlaskConical size={12} className="mr-1" />
                        Test
                      </Button>
                    </div>

                    {patternTestResult && (
                      <div className="mt-1.5 rounded border border-[var(--surface-border)] bg-[var(--background-elevated)] px-2 py-1.5 text-[11px]">
                        {patternTestResult.matchCount === 0 ? (
                          <span className="text-[var(--text-muted)]">No matches found.</span>
                        ) : (
                          <div>
                            <span className="font-medium text-[var(--accent)]">
                              {patternTestResult.matchCount} match
                              {patternTestResult.matchCount === 1 ? '' : 'es'}:
                            </span>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {patternTestResult.matches.slice(0, 10).map((m, i) => (
                                <span
                                  key={i}
                                  className="rounded bg-[var(--accent)]/15 px-1.5 py-0.5 font-mono text-[10px] text-[var(--accent)]"
                                >
                                  {m.length > 60 ? m.slice(0, 57) + '...' : m}
                                </span>
                              ))}
                              {patternTestResult.matchCount > 10 && (
                                <span className="text-[var(--text-muted)]">
                                  ...and {patternTestResult.matchCount - 10} more
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Warnings */}
                  {patternWarnings.length > 0 && (
                    <div className="flex gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-400">
                      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                      <div>
                        {patternWarnings.map((w, i) => (
                          <p key={i}>{w}</p>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end gap-2">
                    {editingPattern && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={resetPatternForm}
                        className="text-[11px]"
                      >
                        Cancel
                      </Button>
                    )}
                    <Button
                      size="sm"
                      className="bg-[var(--accent)] text-white hover:brightness-[1.15] text-[11px]"
                      onClick={handleSavePattern}
                      disabled={!patternForm.label || !patternForm.source}
                    >
                      {editingPattern ? 'Update Pattern' : 'Add Pattern'}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </SectionCard>
      </section>

      {/* Findings Modal (F21: Escape key + click-outside to close) */}
      {showFindings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowFindings(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowFindings(false)
          }}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <div
            className="mx-4 max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--surface-border)] px-4 py-3">
              <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                Secret Findings
                {scanFindings && scanFindings.length > 0 && (
                  <span className="ml-2 text-[12px] font-normal text-[var(--text-muted)]">
                    (showing {scanFindings.length}
                    {scanFindings.length >= 100 ? '+' : ''})
                  </span>
                )}
              </h3>
              <button
                type="button"
                onClick={() => setShowFindings(false)}
                className="rounded p-1 transition-colors hover:bg-[var(--surface-border)]/50"
              >
                <X size={16} className="text-[var(--text-muted)]" />
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
              {!scanFindings || scanFindings.length === 0 ? (
                <p className="py-8 text-center text-[13px] text-[var(--text-muted)]">
                  No secrets detected — your conversations are clean.
                </p>
              ) : (
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-[var(--surface-border)] text-left text-[var(--text-muted)]">
                      <th className="pb-2 pr-3">Type</th>
                      <th className="pb-2 pr-3">Preview</th>
                      <th className="pb-2 pr-3">File</th>
                      <th className="pb-2 pr-3">Status</th>
                      <th className="pb-2 pr-3">Date</th>
                      <th className="pb-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scanFindings.map((f) => (
                      <tr key={f.id} className="border-b border-[var(--surface-border)]/50">
                        <td className="py-2 pr-3">
                          <span
                            className={cn(
                              'inline-block rounded px-1.5 py-0.5 text-[10px] font-medium',
                              f.severity === 'critical' && 'bg-red-500/20 text-red-400',
                              f.severity === 'high' && 'bg-amber-500/20 text-amber-400',
                              f.severity === 'medium' && 'bg-yellow-500/20 text-yellow-300'
                            )}
                          >
                            {f.secretType}
                          </span>
                        </td>
                        <td className="py-2 pr-3 font-mono text-[11px] text-[var(--text-secondary)]">
                          {f.redactedPreview}
                        </td>
                        <td
                          className="max-w-[120px] truncate py-2 pr-3 text-[var(--text-muted)]"
                          title={f.sourceFile}
                        >
                          {f.sourceFile.split(/[/\\]/).pop()}
                        </td>
                        <td className="py-2 pr-3">
                          <span
                            className={cn(
                              'inline-block rounded px-1.5 py-0.5 text-[10px] font-medium',
                              f.status === 'found' && 'bg-blue-500/20 text-blue-400',
                              f.status === 'redacted' && 'bg-green-500/20 text-green-400',
                              f.status === 'ignored' && 'bg-gray-500/20 text-gray-400'
                            )}
                          >
                            {f.status}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-[var(--text-muted)]">
                          {new Date(f.scannedAt).toLocaleDateString()}
                        </td>
                        <td className="py-2">
                          {f.status === 'found' && (
                            <div className="flex gap-1">
                              <button
                                type="button"
                                onClick={() => handleRedactFinding(f.id)}
                                className="rounded px-2 py-0.5 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-500/15"
                              >
                                Redact
                              </button>
                              <button
                                type="button"
                                onClick={() => handleIgnoreFinding(f.id)}
                                className="rounded px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-border)]/50"
                              >
                                Ignore
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {scanFindings && scanFindings.some((f) => f.status === 'found') && (
              <div className="flex justify-end border-t border-[var(--surface-border)] px-4 py-3">
                <Button
                  size="sm"
                  className="bg-red-600 text-white hover:bg-red-700"
                  onClick={handleRedactAll}
                  disabled={isRedacting}
                >
                  {isRedacting && <LoaderCircle size={14} className="mr-1 animate-spin" />}
                  {isRedacting ? 'Redacting...' : 'Redact All Found'}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Appearance */}
      <section>
        <SectionHeader title="Appearance" />
        <SectionCard>
          <label className="mb-2 block text-[12px] font-semibold text-[var(--text-primary)]">
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
                {currentAccent === theme.id && <span className="text-[14px] text-white">✓</span>}
              </button>
            ))}
          </div>
        </SectionCard>
      </section>

      {/* App Info */}
      <section>
        <SectionCard>
          <div className="flex items-center justify-between text-[12px] text-[var(--text-muted)]">
            <span>ClauTime v{appVersion ?? '0.1.0'}</span>
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => {
                  userTriggeredCheck.current = true
                  window.api.updater.checkForUpdates()
                  toast.info('Checking for updates…')
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
        open={confirmRemoveStripeKey}
        title={`Remove ${isStripeTestMode ? 'Sandbox' : 'Live'} Stripe Key`}
        description={`Remove your Stripe ${isStripeTestMode ? 'sandbox' : 'live'} API key? You will need to re-enter it to send invoices in ${isStripeTestMode ? 'test' : 'live'} mode.`}
        confirmLabel="Remove"
        cancelLabel="Keep"
        variant="destructive"
        onConfirm={() => {
          setConfirmRemoveStripeKey(false)
          removeStripeKey.mutate(stripeMode)
        }}
        onCancel={() => setConfirmRemoveStripeKey(false)}
      />

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
        open={confirmDeletePattern !== null}
        title="Delete Custom Pattern"
        description="Remove this pattern? It will no longer be used during scans."
        confirmLabel="Delete"
        cancelLabel="Keep"
        variant="destructive"
        onConfirm={() => confirmDeletePattern && handleDeletePattern(confirmDeletePattern)}
        onCancel={() => setConfirmDeletePattern(null)}
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
