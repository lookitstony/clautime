import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StatusBar } from './StatusBar'

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
    sessions: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      scan: vi.fn(),
      getById: vi.fn()
    },
    clients: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] })
    },
    projects: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      attributeSessions: vi.fn().mockResolvedValue({ success: true, data: 0 })
    }
  })
})

describe('StatusBar', () => {
  it('renders with default values when no sessions', async () => {
    render(<StatusBar />, { wrapper: createWrapper() })
    expect(screen.getByText('0 sessions')).toBeInTheDocument()
    expect(screen.getByText(/total/)).toBeInTheDocument()
  })

  it('has status role for accessibility', () => {
    render(<StatusBar />, { wrapper: createWrapper() })
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('renders total hours', () => {
    render(<StatusBar />, { wrapper: createWrapper() })
    expect(screen.getByText(/total/)).toBeInTheDocument()
  })
})
