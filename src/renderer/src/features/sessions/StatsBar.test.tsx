import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StatsBar } from './StatsBar'

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
    settings: {
      get: vi.fn().mockResolvedValue({ success: true, data: null }),
      set: vi.fn().mockResolvedValue({ success: true, data: undefined })
    }
  })
})

const baseProps = {
  humanHours: '1h 30m',
  totalHours: '2h 30m',
  totalSessions: 15,
  totalPrompts: 1234,
  totalTokens: 125000,
  clientCount: 0,
  commitSessions: 0,
  estimatedCost: null,
  isLoading: false
}

describe('StatsBar', () => {
  it('renders stat values', async () => {
    render(<StatsBar {...baseProps} />, { wrapper: createWrapper() })
    expect(await screen.findByText('1h 30m')).toBeInTheDocument()
    expect(screen.getByText('2h 30m')).toBeInTheDocument()
    expect(screen.getByText('15')).toBeInTheDocument()
    expect(screen.getByText('1,234')).toBeInTheDocument()
  })

  it('renders labels', async () => {
    render(<StatsBar {...baseProps} />, { wrapper: createWrapper() })
    expect(await screen.findByText('Human Hours')).toBeInTheDocument()
    expect(screen.getByText('Agent Hours')).toBeInTheDocument()
    expect(screen.getByText('Sessions')).toBeInTheDocument()
    expect(screen.getByText('Prompts')).toBeInTheDocument()
  })

  it('renders skeleton when loading', () => {
    const { container } = render(<StatsBar {...baseProps} isLoading={true} />, {
      wrapper: createWrapper()
    })
    expect(screen.queryByText('Human Hours')).not.toBeInTheDocument()
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBeGreaterThan(0)
  })

  it('shows client count when clients exist', async () => {
    render(<StatsBar {...baseProps} clientCount={3} />, { wrapper: createWrapper() })
    expect(await screen.findByText('Clients')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('hides client card when no clients', async () => {
    render(<StatsBar {...baseProps} clientCount={0} />, { wrapper: createWrapper() })
    await screen.findByText('Human Hours')
    expect(screen.queryByText('Clients')).not.toBeInTheDocument()
  })

  it('shows estimated cost card when provided', async () => {
    render(<StatsBar {...baseProps} estimatedCost="$1,234" />, { wrapper: createWrapper() })
    expect(await screen.findByText('Est. API Cost')).toBeInTheDocument()
    expect(screen.getByText('$1,234')).toBeInTheDocument()
  })

  it('hides estimated cost card when null', async () => {
    render(<StatsBar {...baseProps} estimatedCost={null} />, { wrapper: createWrapper() })
    await screen.findByText('Human Hours')
    expect(screen.queryByText('Est. API Cost')).not.toBeInTheDocument()
  })

  it('hides cards the user switched off', async () => {
    vi.mocked(window.api.settings.get).mockResolvedValue({
      success: true,
      data: JSON.stringify({ order: [], hidden: ['prompts'] })
    } as never)
    render(<StatsBar {...baseProps} />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.queryByText('Prompts')).not.toBeInTheDocument()
    })
  })

  it('orders cards by saved layout', async () => {
    vi.mocked(window.api.settings.get).mockResolvedValue({
      success: true,
      data: JSON.stringify({ order: ['sessions', 'human-hours'], hidden: [] })
    } as never)
    render(<StatsBar {...baseProps} />, { wrapper: createWrapper() })
    await waitFor(() => {
      const labels = screen.getAllByText(/Sessions|Human Hours/).map((el) => el.textContent)
      expect(labels.indexOf('Sessions')).toBeLessThan(labels.indexOf('Human Hours'))
    })
  })
})
