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
            projectPath: 'C:\\apps\\ClawdTime',
            projectName: 'ClawdTime',
            encodedName: 'C--apps-ClawdTime',
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
    expect(screen.getByText('Scan for Projects')).toBeInTheDocument()
    expect(screen.getByText('Pick a Specific Folder')).toBeInTheDocument()
    expect(screen.getByText('Skip for now')).toBeInTheDocument()
  })

  it('calls onComplete when skip is clicked', async () => {
    const onComplete = vi.fn()
    render(<WelcomeWizard onComplete={onComplete} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByText('Skip for now'))
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled()
    })
  })

  it('marks setup_complete when skipping', async () => {
    render(<WelcomeWizard onComplete={vi.fn()} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByText('Skip for now'))
    await waitFor(() => {
      expect(window.api.settings.set).toHaveBeenCalledWith('setup_complete', 'true')
    })
  })

  it('auto-discovers projects when scan button clicked (no folder picker)', async () => {
    render(<WelcomeWizard onComplete={vi.fn()} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByText('Scan for Projects'))
    await waitFor(() => {
      expect(window.api.dialog.discoverProjects).toHaveBeenCalledWith(undefined)
    })
    // Should NOT open folder picker
    expect(window.api.dialog.openFolder).not.toHaveBeenCalled()
  })

  it('shows confirm step after auto-scan discovery', async () => {
    render(<WelcomeWizard onComplete={vi.fn()} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByText('Scan for Projects'))
    await waitFor(() => {
      expect(screen.getByText('Found 1 Project')).toBeInTheDocument()
    })
    expect(screen.getByText('ClawdTime')).toBeInTheDocument()
    expect(screen.getByText('Confirm & Scan')).toBeInTheDocument()
  })

  it('opens folder picker when "Pick a Specific Folder" clicked', async () => {
    render(<WelcomeWizard onComplete={vi.fn()} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByText('Pick a Specific Folder'))
    await waitFor(() => {
      expect(window.api.dialog.openFolder).toHaveBeenCalled()
    })
    // Should pass the selected folder to discover
    await waitFor(() => {
      expect(window.api.dialog.discoverProjects).toHaveBeenCalledWith('/projects')
    })
  })

  it('stays on welcome step when folder picker is cancelled', async () => {
    vi.stubGlobal('api', {
      ...window.api,
      dialog: {
        openFolder: vi.fn().mockResolvedValue({ success: true, data: null }),
        discoverProjects: vi.fn()
      }
    })

    render(<WelcomeWizard onComplete={vi.fn()} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByText('Pick a Specific Folder'))

    await waitFor(() => {
      expect(screen.getByText('Welcome to ViberTime')).toBeInTheDocument()
    })
    expect(window.api.dialog.discoverProjects).not.toHaveBeenCalled()
  })

  it('shows no projects found when discovery returns empty', async () => {
    vi.stubGlobal('api', {
      ...window.api,
      dialog: {
        ...window.api.dialog,
        discoverProjects: vi.fn().mockResolvedValue({ success: true, data: [] })
      }
    })

    render(<WelcomeWizard onComplete={vi.fn()} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByText('Scan for Projects'))
    await waitFor(() => {
      expect(screen.getByText('No Projects Found')).toBeInTheDocument()
    })
  })

  it('shows complete step after confirm and scan finishes', async () => {
    const onComplete = vi.fn()
    render(<WelcomeWizard onComplete={onComplete} />, { wrapper: createWrapper() })

    fireEvent.click(screen.getByText('Scan for Projects'))
    await waitFor(() => {
      expect(screen.getByText('Confirm & Scan')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Confirm & Scan'))
    await waitFor(() => {
      expect(screen.getByText("You're All Set!")).toBeInTheDocument()
    })
    expect(screen.getByText('Get Started')).toBeInTheDocument()
  })
})
