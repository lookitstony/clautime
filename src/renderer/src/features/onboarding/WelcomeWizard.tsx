import { useState, useCallback } from 'react'
import { FolderSearch, FolderOpen, ArrowRight, Loader2, Check, AlertTriangle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  useOpenFolderPicker,
  useDiscoverProjects,
  useCompleteSetup
} from './use-onboarding'
import { useScanSessions } from '@/features/sessions/use-sessions'
import type { DiscoveredProject } from '../../../../shared/types/session'

type WizardStep = 'welcome' | 'discovery' | 'confirm' | 'scanning' | 'complete'

interface WelcomeWizardProps {
  onComplete: () => void
}

export function WelcomeWizard({ onComplete }: WelcomeWizardProps): React.JSX.Element {
  const [step, setStep] = useState<WizardStep>('welcome')
  const [projects, setProjects] = useState<DiscoveredProject[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [scanResult, setScanResult] = useState<{ sessions: number; projects: number } | null>(null)

  const folderPicker = useOpenFolderPicker()
  const discover = useDiscoverProjects()
  const completeSetup = useCompleteSetup()
  const scanMutation = useScanSessions()

  // Auto-scan: reads ~/.claude/projects/ directly
  const handleScanAll = useCallback(async () => {
    setStep('discovery')
    const discovered = await discover.mutateAsync()
    setProjects(discovered)
    setSelectedPaths(new Set(discovered.map((p) => p.projectPath)))
    setStep('confirm')
  }, [discover])

  // Folder-filtered scan: pick a folder, then show only projects under it
  const handleScanFolder = useCallback(async () => {
    const folder = await folderPicker.mutateAsync()
    if (!folder) return // User cancelled

    setStep('discovery')
    const discovered = await discover.mutateAsync(folder)
    setProjects(discovered)
    setSelectedPaths(new Set(discovered.map((p) => p.projectPath)))
    setStep('confirm')
  }, [folderPicker, discover])

  const handleConfirmAndScan = useCallback(async () => {
    setStep('scanning')
    // Build filter of encoded project names for only selected projects
    const encodedNames = projects
      .filter((p) => selectedPaths.has(p.projectPath))
      .map((p) => p.encodedName)
    const result = await scanMutation.mutateAsync(encodedNames)
    setScanResult({
      sessions: result.newSessions,
      projects: selectedPaths.size
    })
    setStep('complete')
  }, [scanMutation, projects, selectedPaths])

  const handleComplete = useCallback(async () => {
    await completeSetup.mutateAsync()
    onComplete()
  }, [completeSetup, onComplete])

  const handleSkip = useCallback(async () => {
    await completeSetup.mutateAsync()
    onComplete()
  }, [completeSetup, onComplete])

  const toggleProject = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    if (selectedPaths.size === projects.length) {
      setSelectedPaths(new Set())
    } else {
      setSelectedPaths(new Set(projects.map((p) => p.projectPath)))
    }
  }, [selectedPaths.size, projects])

  return (
    <Dialog open modal>
      <DialogContent
        className="max-w-md border-[var(--surface-border)] bg-[var(--background-primary)] text-[var(--text-primary)] [&>button]:hidden"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        {step === 'welcome' && (
          <WelcomeStep
            onScanAll={handleScanAll}
            onScanFolder={handleScanFolder}
            onSkip={handleSkip}
            isLoading={discover.isPending || folderPicker.isPending}
          />
        )}
        {step === 'discovery' && <DiscoveryStep />}
        {step === 'confirm' && (
          <ConfirmStep
            projects={projects}
            selectedPaths={selectedPaths}
            onToggle={toggleProject}
            onToggleAll={toggleAll}
            onConfirm={handleConfirmAndScan}
            onBack={() => setStep('welcome')}
          />
        )}
        {step === 'scanning' && <ScanningStep />}
        {step === 'complete' && (
          <CompleteStep
            sessions={scanResult?.sessions ?? 0}
            projects={scanResult?.projects ?? 0}
            onGetStarted={handleComplete}
            isLoading={completeSetup.isPending}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function WelcomeStep({
  onScanAll,
  onScanFolder,
  onSkip,
  isLoading
}: {
  onScanAll: () => void
  onScanFolder: () => void
  onSkip: () => void
  isLoading: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 py-4 text-center">
      <DialogTitle className="text-xl font-bold">Welcome to ViberTime</DialogTitle>
      <DialogDescription className="text-[var(--text-muted)]">
        Let's find your Claude Code projects and reconstruct your work history.
      </DialogDescription>
      <Button
        onClick={onScanAll}
        disabled={isLoading}
        className="mt-2 w-full bg-[var(--accent)] text-white hover:brightness-[1.15]"
      >
        {isLoading ? (
          <>
            <Loader2 size={16} className="mr-2 animate-spin" />
            Scanning...
          </>
        ) : (
          <>
            <FolderSearch size={16} className="mr-2" />
            Scan for Projects
          </>
        )}
      </Button>
      <Button
        onClick={onScanFolder}
        disabled={isLoading}
        variant="outline"
        className="w-full border-[var(--surface-border)]"
      >
        <FolderOpen size={16} className="mr-2" />
        Pick a Specific Folder
      </Button>
      <button
        onClick={onSkip}
        className="text-[13px] text-[var(--text-muted)] underline-offset-4 hover:underline"
      >
        Skip for now
      </button>
    </div>
  )
}

function DiscoveryStep(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <DialogTitle className="sr-only">Scanning for projects</DialogTitle>
      <Loader2 size={32} className="animate-spin text-[var(--accent)]" />
      <p className="text-[14px] font-semibold">Scanning for projects...</p>
      <DialogDescription className="text-[13px] text-[var(--text-muted)]">
        Reading your Claude Code project history
      </DialogDescription>
    </div>
  )
}

function ConfirmStep({
  projects,
  selectedPaths,
  onToggle,
  onToggleAll,
  onConfirm,
  onBack
}: {
  projects: DiscoveredProject[]
  selectedPaths: Set<string>
  onToggle: (path: string) => void
  onToggleAll: () => void
  onConfirm: () => void
  onBack: () => void
}): React.JSX.Element {
  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <DialogTitle className="sr-only">No projects found</DialogTitle>
        <AlertTriangle size={32} className="text-[var(--text-muted)]" />
        <p className="text-[14px] font-semibold">No Projects Found</p>
        <DialogDescription className="text-[13px] text-[var(--text-muted)]">
          No Claude Code projects were found. Make sure you've used Claude Code at least once.
        </DialogDescription>
        <Button
          onClick={onBack}
          variant="outline"
          className="w-full border-[var(--surface-border)]"
        >
          Back
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <DialogTitle className="text-lg font-bold">
        Found {projects.length} Project{projects.length !== 1 ? 's' : ''}
      </DialogTitle>
      <DialogDescription className="text-[13px] text-[var(--text-muted)]">
        Select which projects to include in your time tracking.
      </DialogDescription>
      <div className="flex items-center gap-2 border-b border-[var(--surface-border)] pb-2">
        <Checkbox
          checked={selectedPaths.size === projects.length}
          onCheckedChange={onToggleAll}
          id="select-all"
        />
        <label htmlFor="select-all" className="cursor-pointer text-[12px] text-[var(--text-muted)]">
          {selectedPaths.size === projects.length ? 'Deselect All' : 'Select All'}
        </label>
      </div>
      <div className="max-h-60 overflow-auto">
        {projects.map((project) => (
          <label
            key={project.encodedName}
            className="flex cursor-pointer items-center gap-3 rounded px-2 py-2 hover:bg-[var(--background-elevated)]"
          >
            <Checkbox
              checked={selectedPaths.has(project.projectPath)}
              onCheckedChange={() => onToggle(project.projectPath)}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold">{project.projectName}</p>
              <p className="truncate text-[11px] text-[var(--text-muted)]">
                {project.projectPath}
              </p>
            </div>
          </label>
        ))}
      </div>
      <div className="flex gap-2 pt-2">
        <Button
          onClick={onBack}
          variant="outline"
          className="flex-1 border-[var(--surface-border)]"
        >
          Back
        </Button>
        <Button
          onClick={onConfirm}
          disabled={selectedPaths.size === 0}
          className="flex-1 bg-[var(--accent)] text-white hover:brightness-[1.15]"
        >
          Confirm & Scan
          <ArrowRight size={16} className="ml-2" />
        </Button>
      </div>
    </div>
  )
}

function ScanningStep(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <DialogTitle className="sr-only">Scanning sessions</DialogTitle>
      <Loader2 size={32} className="animate-spin text-[var(--accent)]" />
      <p className="text-[14px] font-semibold">Scanning sessions...</p>
      <DialogDescription className="text-[13px] text-[var(--text-muted)]">
        Discovering your Claude Code work history
      </DialogDescription>
    </div>
  )
}

function CompleteStep({
  sessions,
  projects,
  onGetStarted,
  isLoading
}: {
  sessions: number
  projects: number
  onGetStarted: () => void
  isLoading: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 py-4 text-center">
      <DialogTitle className="sr-only">Setup complete</DialogTitle>
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[rgba(var(--accent-rgb),0.15)]">
        <Check size={24} className="text-[var(--accent)]" />
      </div>
      <p className="text-lg font-bold">You're All Set!</p>
      <DialogDescription className="text-[13px] text-[var(--text-muted)]">
        Found {sessions} session{sessions !== 1 ? 's' : ''} across {projects} project
        {projects !== 1 ? 's' : ''}.
      </DialogDescription>
      <Button
        onClick={onGetStarted}
        disabled={isLoading}
        className="mt-2 w-full bg-[var(--accent)] text-white hover:brightness-[1.15]"
      >
        {isLoading ? (
          <>
            <Loader2 size={16} className="mr-2 animate-spin" />
            Finishing setup...
          </>
        ) : (
          'Get Started'
        )}
      </Button>
    </div>
  )
}
