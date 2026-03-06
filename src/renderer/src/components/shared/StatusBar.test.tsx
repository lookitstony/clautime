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
    live: {
      getTodayStats: vi.fn().mockResolvedValue({
        success: true,
        data: { humanHours: '2h 30m', agentHours: '1h', totalSessions: 5, totalPrompts: 42, totalTokens: 10000, totalCommits: 3 }
      })
    }
  })
})

describe('StatusBar', () => {
  it('renders today stats', async () => {
    render(<StatusBar />, { wrapper: createWrapper() })
    expect(await screen.findByText('5 sessions today')).toBeInTheDocument()
    expect(screen.getByText(/today/)).toBeInTheDocument()
  })

  it('has status role for accessibility', () => {
    render(<StatusBar />, { wrapper: createWrapper() })
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
