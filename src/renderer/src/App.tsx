import { useCallback, useEffect, useState } from 'react'
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider, Outlet, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
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
import { useIsFirstLaunch } from '@/features/onboarding/use-onboarding'
import { queryClient } from '@/lib/query-client'
import { useLiveStore } from '@/stores/use-live-store'
import { ManualTimerDialog } from '@/features/live/ManualTimerDialog'
import { useLiveBroadcastSync } from '@/features/live/use-live'
import type { ProjectLiveStatus } from '../../shared/types/live'

function useFileWatcherEvents(): void {
  const qc = useQueryClient()

  useEffect(() => {
    window.api.live.onSessionsUpdated(() => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['live'] })
      qc.invalidateQueries({ queryKey: ['git'] })
    })

    window.api.live.onNewProject((info) => {
      toast.info(`New project detected: ${info.projectName}`, {
        description: info.decodedPath,
        duration: 10000,
        action: {
          label: 'Add',
          onClick: () => {
            // Navigate to clients page where they can add it
            window.dispatchEvent(new CustomEvent('navigate', { detail: '/clients' }))
          }
        }
      })
      qc.invalidateQueries({ queryKey: ['projects'] })
    })
  }, [qc])
}

function RootLayout(): React.JSX.Element {
  useFileWatcherEvents()
  useLiveBroadcastSync()
  const { isFirstLaunch, isLoading } = useIsFirstLaunch()
  const navigate = useNavigate()
  const [stopDialog, setStopDialog] = useState<{ open: boolean; project: ProjectLiveStatus | null }>({ open: false, project: null })

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
              <Outlet />
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
