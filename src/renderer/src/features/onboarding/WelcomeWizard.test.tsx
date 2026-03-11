import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WelcomeWizard } from './WelcomeWizard'

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
      set: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      getAll: vi.fn().mockResolvedValue({ success: true, data: {} })
    }
  })
})

describe('WelcomeWizard', () => {
  it('renders welcome title and feature list', () => {
    render(<WelcomeWizard onComplete={vi.fn()} />, { wrapper: createWrapper() })
    expect(screen.getByText('Welcome to ClauTime')).toBeInTheDocument()
    expect(screen.getByText('Live View')).toBeInTheDocument()
    expect(screen.getByText('Sessions')).toBeInTheDocument()
    expect(screen.getByText('Reports & Analytics')).toBeInTheDocument()
    expect(screen.getByText('Desktop Widgets')).toBeInTheDocument()
    expect(screen.getByText('Clients & Projects')).toBeInTheDocument()
    expect(screen.getByText('Get Started')).toBeInTheDocument()
  })

  it('calls onComplete and marks setup_complete when Get Started is clicked', async () => {
    const onComplete = vi.fn()
    render(<WelcomeWizard onComplete={onComplete} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByText('Get Started'))
    await waitFor(() => {
      expect(window.api.settings.set).toHaveBeenCalledWith('setup_complete', 'true')
    })
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled()
    })
  })

  it('shows auto-detect message', () => {
    render(<WelcomeWizard onComplete={vi.fn()} />, { wrapper: createWrapper() })
    expect(screen.getByText(/auto-detected/)).toBeInTheDocument()
  })
})
