import { createMemoryRouter, RouterProvider, Outlet } from 'react-router'
import {
  LayoutList,
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

function RootLayout(): React.JSX.Element {
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
        element: (
          <EmptyState
            icon={LayoutList}
            title="No Sessions Yet"
            description="Sessions will appear here once scanning is configured"
          />
        )
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
  return <RouterProvider router={router} />
}

export default App
