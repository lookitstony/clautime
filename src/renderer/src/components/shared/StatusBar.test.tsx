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
    }
  })
})

describe('StatusBar', () => {
  it('renders with default values when no sessions', async () => {
    render(<StatusBar />, { wrapper: createWrapper() })
    expect(screen.getByText('Watching 0 projects')).toBeInTheDocument()
    expect(screen.getByText(/today/)).toBeInTheDocument()
  })

  it('has status role for accessibility', () => {
    render(<StatusBar />, { wrapper: createWrapper() })
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('renders scan status', () => {
    render(<StatusBar />, { wrapper: createWrapper() })
    expect(screen.getByText('Last scan: never')).toBeInTheDocument()
  })
})
