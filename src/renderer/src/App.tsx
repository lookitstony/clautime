import { useCallback, useEffect, useState } from 'react'
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider, Outlet, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { Toaster } from '@/components/ui/sonner'
import { TitleBar } from '@/components/shared/TitleBar'
import { ActivityBar } from '@/components/shared/ActivityBar'
import { StatusBar } from '@/components/shared/StatusBar'
import { SessionsPage } from '@/features/sessions/SessionsPage'
import { ClientsPage } from '@/features/clients/ClientsPage'
import { WelcomeWizard } from '@/features/onboarding/WelcomeWizard'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { ReportsPage } from '@/features/reports/ReportsPage'
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage'
import { LivePage } from '@/features/live/LivePage'
import { InvoicingPage } from '@/features/invoicing/InvoicingPage'
import { useIsFirstLaunch } from '@/features/onboarding/use-onboarding'
import { queryClient } from '@/lib/query-client'
import { useLiveStore } from '@/stores/use-live-store'
import { ManualTimerDialog } from '@/features/live/ManualTimerDialog'
import { useLiveBroadcastSync } from '@/features/live/use-live'
import { useUpdaterNotifications } from '@/features/settings/use-updater'
import type { ProjectLiveStatus } from '../../shared/types/live'

// While you're actively coding, the file watcher emits a scan-complete event
// every few seconds (across every Claude profile). Invalidating on each one
// forces immediate refetches and makes the panels visibly churn. Throttle the
// invalidation (leading + trailing) so bursts coalesce; the Live page keeps its
// own 15s poll, so real-time freshness is unaffected.
const WATCHER_INVALIDATE_THROTTLE_MS = 10_000

function useFileWatcherEvents(): void {
  const qc = useQueryClient()

  useEffect(() => {
    let lastRun = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = (): void => {
      lastRun = Date.now()
      timer = null
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['git'] })
      // Note: ['live'] is intentionally NOT invalidated here — the Live page
      // polls its own data every 15s, and forcing the (heavy, FS-walking)
      // live-monitor recompute on every file change piles work onto the main
      // process and contributes to UI stalls.
    }

    const schedule = (): void => {
      if (timer) return // a trailing flush is already pending
      const elapsed = Date.now() - lastRun
      if (elapsed >= WATCHER_INVALIDATE_THROTTLE_MS) {
        flush() // leading edge — refresh immediately
      } else {
        timer = setTimeout(flush, WATCHER_INVALIDATE_THROTTLE_MS - elapsed)
      }
    }

    window.api.live.onSessionsUpdated(schedule)

    window.api.live.onNewProject((info) => {
      toast.info(`New project detected: ${info.projectName}`, {
        description: info.decodedPath,
        duration: 5000
      })
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['live'] })
    })

    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [qc])
}

function RootLayout(): React.JSX.Element {
  useFileWatcherEvents()
  useLiveBroadcastSync()
  useUpdaterNotifications()
  const { isFirstLaunch, isLoading } = useIsFirstLaunch()
  const navigate = useNavigate()
  const [stopDialog, setStopDialog] = useState<{
    open: boolean
    project: ProjectLiveStatus | null
  }>({ open: false, project: null })

  // Listen for stop dialog requests from widgets
  useEffect(() => {
    const handler = (_projectId: number): void => {
      const timer = useLiveStore.getState().activeTimer
      if (!timer) return
      setStopDialog({
        open: true,
        project: {
          projectId: timer.projectId,
          projectName: timer.projectName,
          projectPath: timer.projectPath,
          clientId: timer.clientId,
          clientName: timer.clientName,
          lastPromptAt: null,
          isProcessing: false,
          isWatching: false,
          alertSound: 'system',
          totalHours: '0m',
          sessionCount: 0,
          totalPrompts: 0,
          totalTokens: 0,
          totalCommits: 0
        }
      })
    }
    window.api.live.onOpenStopDialog(handler)
  }, [])

  // Listen for navigate events from toast actions
  useEffect(() => {
    const handler = (e: Event): void => {
      const path = (e as CustomEvent).detail
      if (path) navigate(path)
    }
    window.addEventListener('navigate', handler)
    return () => window.removeEventListener('navigate', handler)
  }, [navigate])

  const handleWizardComplete = useCallback(() => {
    navigate('/sessions')
  }, [navigate])

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-[var(--background-primary)] text-[var(--text-primary)]">
        <TitleBar />
        <div className="flex flex-1 overflow-hidden">
          <ActivityBar />
          <div className="flex flex-1 flex-col overflow-hidden">
            <main className="flex-1 overflow-auto">
              <ErrorBoundary>
                <Outlet />
              </ErrorBoundary>
            </main>
            <StatusBar />
          </div>
        </div>
      </div>
      {!isLoading && isFirstLaunch && <WelcomeWizard onComplete={handleWizardComplete} />}
      {stopDialog.project && (
        <ManualTimerDialog
          open={stopDialog.open}
          mode="stop"
          project={stopDialog.project}
          onClose={() => setStopDialog({ open: false, project: null })}
        />
      )}
      <Toaster />
    </TooltipProvider>
  )
}

const router = createMemoryRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      {
        index: true,
        element: <LivePage />
      },
      {
        path: 'sessions',
        element: <SessionsPage />
      },
      {
        path: 'reports',
        element: <ReportsPage />
      },
      {
        path: 'analytics',
        element: <AnalyticsPage />
      },
      {
        path: 'clients',
        element: <ClientsPage />
      },
      {
        path: 'invoicing',
        element: <InvoicingPage />
      },
      {
        path: 'settings',
        element: <SettingsPage />
      }
    ]
  }
])

function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

export default App
