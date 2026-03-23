import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ClientsPage } from './ClientsPage'
import type { Client } from '../../../../shared/types/client-project'

const mockClients: Client[] = [
  {
    id: 1,
    name: 'Acme Corp',
    color: 'var(--project-1)',
    billableRate: null,
    email: null,
    stripeCustomerId: null,
    isActive: true,
    createdAt: '2026-03-04T00:00:00.000Z',
    updatedAt: '2026-03-04T00:00:00.000Z'
  },
  {
    id: 2,
    name: 'Beta Inc',
    color: 'var(--project-2)',
    billableRate: null,
    email: null,
    stripeCustomerId: null,
    isActive: true,
    createdAt: '2026-03-04T00:00:00.000Z',
    updatedAt: '2026-03-04T00:00:00.000Z'
  }
]

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  vi.stubGlobal('api', {
    clients: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      create: vi.fn().mockResolvedValue({ success: true, data: mockClients[0] }),
      update: vi.fn().mockResolvedValue({ success: true, data: mockClients[0] }),
      delete: vi.fn().mockResolvedValue({ success: true, data: undefined })
    },
    projects: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      attributeSessions: vi.fn()
    }
  })
})

describe('ClientsPage', () => {
  it('shows empty state when no clients', async () => {
    render(<ClientsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('No clients configured')).toBeInTheDocument()
    })
    expect(
      screen.getByText('Add clients and projects to organize your sessions')
    ).toBeInTheDocument()
  })

  it('shows loading skeleton while fetching', () => {
    // Make the API hang to test loading state
    vi.stubGlobal('api', {
      ...window.api,
      clients: {
        ...window.api.clients,
        getAll: vi.fn().mockReturnValue(new Promise(() => {}))
      }
    })
    render(<ClientsPage />, { wrapper: createWrapper() })
    // Skeleton elements render with animate-pulse class
    const skeletons = document.querySelectorAll('[class*="animate-pulse"]')
    expect(skeletons.length).toBeGreaterThan(0)
  })

  it('renders client list when clients exist', async () => {
    vi.stubGlobal('api', {
      ...window.api,
      clients: {
        ...window.api.clients,
        getAll: vi.fn().mockResolvedValue({ success: true, data: mockClients })
      }
    })

    render(<ClientsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    })
    expect(screen.getByText('Beta Inc')).toBeInTheDocument()
  })

  it('shows header with title and Add Client button', async () => {
    render(<ClientsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Projects & Clients')).toBeInTheDocument()
    })
    // Header Add Client button
    expect(screen.getByRole('button', { name: 'Add Client' })).toBeInTheDocument()
  })

  it('shows error state when fetch fails', async () => {
    vi.stubGlobal('api', {
      ...window.api,
      clients: {
        ...window.api.clients,
        getAll: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'ERR', message: 'Database error' }
        })
      }
    })

    render(<ClientsPage />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Failed to Load Clients')).toBeInTheDocument()
    })
  })
})
