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
    dialog: {
      openFolder: vi.fn().mockResolvedValue({ success: true, data: '/projects' }),
      discoverProjects: vi.fn().mockResolvedValue({
        success: true,
        data: [
          {
            projectPath: 'C:/apps/ClawdTime',
            projectName: 'ClawdTime',
            encodedName: 'C-%5Capps%5CClawdTime',
            hasClaudeDir: true
          }
        ]
      })
    },
    settings: {
      get: vi.fn().mockResolvedValue({ success: true, data: null }),
      set: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      getAll: vi.fn().mockResolvedValue({ success: true, data: {} })
    },
    sessions: {
      scan: vi.fn().mockResolvedValue({
        success: true,
        data: { newSessions: 5, updatedFiles: 3, totalFiles: 10, durationMs: 100 }
      }),
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getById: vi.fn()
    }
  })
})

describe('WelcomeWizard', () => {
  it('renders welcome step with title and buttons', () => {
    render(<WelcomeWizard onComplete={vi.fn()} />, { wrapper: createWrapper() })
    expect(screen.getByText('Welcome to ViberTime')).toBeInTheDocument()
    expect(screen.getByText('Scan My Projects Folder')).toBeInTheDocument()
    expect(screen.getByText("I'll set up manually")).toBeInTheDocument()
  })

  it('calls onComplete when skip is clicked', async () => {
    const onComplete = vi.fn()
    render(<WelcomeWizard onComplete={onComplete} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByText("I'll set up manually"))
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled()
    })
  })

  it('marks setup_complete when skipping', async () => {
    render(<WelcomeWizard onComplete={vi.fn()} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByText("I'll set up manually"))
    await waitFor(() => {
      expect(window.api.settings.set).toHaveBeenCalledWith('setup_complete', 'true')
    })
  })

  it('opens folder picker when scan button clicked', async () => {
    render(<WelcomeWizard onComplete={vi.fn()} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByText('Scan My Projects Folder'))
    await waitFor(() => {
      expect(window.api.dialog.openFolder).toHaveBeenCalled()
    })
  })

  it('shows confirm step after folder selection and discovery', async () => {
    render(<WelcomeWizard onComplete={vi.fn()} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByText('Scan My Projects Folder'))
    await waitFor(() => {
      expect(screen.getByText('Found 1 Project')).toBeInTheDocument()
    })
    expect(screen.getByText('ClawdTime')).toBeInTheDocument()
    expect(screen.getByText('Confirm & Scan')).toBeInTheDocument()
  })

  it('shows no projects found when discovery returns empty', async () => {
    vi.stubGlobal('api', {
      ...window.api,
      dialog: {
        openFolder: vi.fn().mockResolvedValue({ success: true, data: '/empty' }),
        discoverProjects: vi.fn().mockResolvedValue({ success: true, data: [] })
      }
    })

    render(<WelcomeWizard onComplete={vi.fn()} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByText('Scan My Projects Folder'))
    await waitFor(() => {
      expect(screen.getByText('No Projects Found')).toBeInTheDocument()
    })
  })

  it('shows complete step after scan finishes', async () => {
    const onComplete = vi.fn()
    render(<WelcomeWizard onComplete={onComplete} />, { wrapper: createWrapper() })

    // Click scan
    fireEvent.click(screen.getByText('Scan My Projects Folder'))
    await waitFor(() => {
      expect(screen.getByText('Confirm & Scan')).toBeInTheDocument()
    })

    // Confirm and scan
    fireEvent.click(screen.getByText('Confirm & Scan'))
    await waitFor(() => {
      expect(screen.getByText("You're All Set!")).toBeInTheDocument()
    })
    expect(screen.getByText('Get Started')).toBeInTheDocument()
  })

  it('does not show wizard when folder picker is cancelled', async () => {
    vi.stubGlobal('api', {
      ...window.api,
      dialog: {
        openFolder: vi.fn().mockResolvedValue({ success: true, data: null }),
        discoverProjects: vi.fn()
      }
    })

    render(<WelcomeWizard onComplete={vi.fn()} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByText('Scan My Projects Folder'))

    // Should stay on welcome step since user cancelled
    await waitFor(() => {
      expect(screen.getByText('Welcome to ViberTime')).toBeInTheDocument()
    })
    expect(window.api.dialog.discoverProjects).not.toHaveBeenCalled()
  })
})
