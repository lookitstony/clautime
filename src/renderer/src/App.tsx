import { createMemoryRouter, RouterProvider, Outlet } from 'react-router'
import { Toaster } from '@/components/ui/sonner'

function RootLayout(): React.JSX.Element {
  return (
    <div className="flex h-screen bg-[var(--background-primary)] text-[var(--text-primary)]">
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
      <Toaster />
    </div>
  )
}

function PlaceholderView({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="mt-2 text-[var(--text-secondary)]">Coming soon</p>
      </div>
    </div>
  )
}

const router = createMemoryRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      { index: true, element: <PlaceholderView title="Live Dashboard" /> },
      { path: 'sessions', element: <PlaceholderView title="Sessions" /> },
      { path: 'reports', element: <PlaceholderView title="Reports" /> },
      { path: 'clients', element: <PlaceholderView title="Clients & Projects" /> },
      { path: 'settings', element: <PlaceholderView title="Settings" /> }
    ]
  }
])

function App(): React.JSX.Element {
  return <RouterProvider router={router} />
}

export default App
