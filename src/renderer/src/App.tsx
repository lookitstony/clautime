import { useCallback } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider, Outlet, useNavigate } from 'react-router'
import {
  Activity,
  FileBarChart,
  Users,
  Settings
} from 'lucide-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { ActivityBar } from '@/components/shared/ActivityBar'
import { StatusBar } from '@/components/shared/StatusBar'
import { EmptyState } from '@/components/shared/EmptyState'
import { SessionsPage } from '@/features/sessions/SessionsPage'
import { WelcomeWizard } from '@/features/onboarding/WelcomeWizard'
import { useIsFirstLaunch } from '@/features/onboarding/use-onboarding'
import { queryClient } from '@/lib/query-client'

function RootLayout(): React.JSX.Element {
  const { isFirstLaunch, isLoading } = useIsFirstLaunch()
  const navigate = useNavigate()

  const handleWizardComplete = useCallback(() => {
    navigate('/sessions')
  }, [navigate])

  return (
    <TooltipProvider>
      <div className="flex h-screen bg-[var(--background-primary)] text-[var(--text-primary)]">
        <ActivityBar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <main className="flex-1 overflow-auto">
            <Outlet />
          </main>
          <StatusBar />
        </div>
      </div>
      {!isLoading && isFirstLaunch && <WelcomeWizard onComplete={handleWizardComplete} />}
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
        element: (
          <EmptyState
            icon={Activity}
            title="No Active Sessions"
            description="Running sessions will appear here in real-time"
          />
        )
      },
      {
        path: 'sessions',
        element: <SessionsPage />
      },
      {
        path: 'reports',
        element: (
          <EmptyState
            icon={FileBarChart}
            title="No Reports"
            description="Generate reports once you have session data"
          />
        )
      },
      {
        path: 'clients',
        element: (
          <EmptyState
            icon={Users}
            title="No Clients"
            description="Add clients and projects to organize your sessions"
          />
        )
      },
      {
        path: 'settings',
        element: (
          <EmptyState
            icon={Settings}
            title="Settings"
            description="Configure your ViberTime preferences"
          />
        )
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
