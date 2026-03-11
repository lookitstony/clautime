import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionDetailPanel } from './SessionDetailPanel'
import type { Session } from '../../../../shared/types/session'

// Mock browser APIs for Radix components
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})
// Radix Select accesses window.HTMLSelectElement.prototype — mock for happy-dom
const HtmlSelectProto = {} as any
Object.defineProperty(HtmlSelectProto, 'value', {
  get() { return '' },
  set(_v: string) {},
  configurable: true,
  enumerable: true
})
vi.stubGlobal('HTMLSelectElement', { prototype: HtmlSelectProto })

// Mock window.api
const mockUpdate = vi.fn().mockResolvedValue({ success: true, data: {} })

vi.stubGlobal('window', {
  ...window,
  api: {
    sessions: {
      getPromptTimings: vi.fn().mockResolvedValue({ success: true, data: [] }),
      update: mockUpdate
    },
    git: { getCommitsForSession: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    ai: { getSummary: vi.fn().mockResolvedValue({ success: true, data: { summary: '', tier: 'none' } }) }
  }
})

const baseSession: Session = {
  id: 1,
  projectPath: 'C:\\apps\\ClauTime',
  startedAt: '2026-03-05T09:15:00.000Z',
  endedAt: '2026-03-05T11:30:00.000Z',
  durationMinutes: 135,
  source: 'auto',
  description: null,
  status: 'completed',
  claudeSessionId: 'abc123',
  promptCount: 24,
  inputTokens: 50000,
  outputTokens: 75000,
  sourceFile: 'test.jsonl',
  projectId: 1,
  clientId: 1,
  createdAt: '2026-03-05T09:15:00.000Z',
  updatedAt: '2026-03-05T11:30:00.000Z'
}

const defaultProps = {
  session: baseSession,
  projectName: 'ClauTime',
  clientName: 'Acme Corp',
  projectColor: 'var(--project-1)',
  onClose: vi.fn()
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SessionDetailPanel', () => {
  it('renders session duration, time range, prompts, and source', () => {
    render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

    expect(screen.getByText('2h 15m')).toBeInTheDocument()
    expect(screen.getByText('Duration')).toBeInTheDocument()
    expect(screen.getByText('Time Range')).toBeInTheDocument()
    expect(screen.getByText('24')).toBeInTheDocument()
    expect(screen.getByText('Prompts')).toBeInTheDocument()
    expect(screen.getByText('Auto-detected')).toBeInTheDocument()
    expect(screen.getByText('Source')).toBeInTheDocument()
  })

  it('renders project and client names', () => {
    render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText('ClauTime')).toBeInTheDocument()
  })

  it('shows "No description" when description is null', () => {
    render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })
    expect(screen.getByText('No description')).toBeInTheDocument()
  })

  it('shows description when present', () => {
    const session = { ...baseSession, description: 'Fixed authentication bug' }
    render(<SessionDetailPanel {...defaultProps} session={session} />, { wrapper: createWrapper() })
    expect(screen.getByText('Fixed authentication bug')).toBeInTheDocument()
    expect(screen.queryByText('No description')).not.toBeInTheDocument()
  })

  it('does not show action buttons for auto sessions', () => {
    render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

    // Auto sessions have no Edit Description or Delete buttons
    expect(screen.queryByRole('button', { name: /edit description/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument()
  })

  it('shows enabled Edit Description and Delete buttons for manual sessions', () => {
    const session = { ...baseSession, source: 'manual' as const }
    render(<SessionDetailPanel {...defaultProps} session={session} />, { wrapper: createWrapper() })

    const editDescBtn = screen.getByRole('button', { name: /edit description/i })
    const deleteBtn = screen.getByRole('button', { name: /^delete$/i })
    expect(editDescBtn).toBeInTheDocument()
    expect(editDescBtn).not.toBeDisabled()
    expect(deleteBtn).toBeInTheDocument()
    expect(deleteBtn).not.toBeDisabled()

    // Should NOT show auto-only buttons
    expect(screen.queryByRole('button', { name: /edit time/i })).not.toBeInTheDocument()
  })

  describe('Manual Session Actions', () => {
    it('shows edit description textarea when Edit Description is clicked', () => {
      const session = { ...baseSession, source: 'manual' as const, description: 'Test desc' }
      render(<SessionDetailPanel {...defaultProps} session={session} />, { wrapper: createWrapper() })

      fireEvent.click(screen.getByRole('button', { name: /edit description/i }))

      const textarea = screen.getByRole('textbox')
      expect(textarea).toBeInTheDocument()
      expect(textarea).toHaveValue('Test desc')
    })

    it('shows delete confirmation when Delete is clicked', () => {
      const session = { ...baseSession, source: 'manual' as const }
      render(<SessionDetailPanel {...defaultProps} session={session} />, { wrapper: createWrapper() })

      fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))

      expect(screen.getByText('Delete this session?')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /confirm/i })).toBeInTheDocument()
    })

    it('cancels delete confirmation', () => {
      const session = { ...baseSession, source: 'manual' as const }
      render(<SessionDetailPanel {...defaultProps} session={session} />, { wrapper: createWrapper() })

      fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

      expect(screen.queryByText('Delete this session?')).not.toBeInTheDocument()
    })
  })

  it('calls onClose when Escape is pressed', () => {
    render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

    const panel = screen.getByRole('region')
    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1)
  })

  it('receives focus on mount', () => {
    render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

    const panel = screen.getByRole('region')
    expect(document.activeElement).toBe(panel)
  })

  it('has correct aria-label', () => {
    render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })
    const panel = screen.getByRole('region')
    expect(panel.getAttribute('aria-label')).toContain('Details for session')
  })

  it('renders manual source text for manual sessions', () => {
    const session = { ...baseSession, source: 'manual' as const }
    render(<SessionDetailPanel {...defaultProps} session={session} />, { wrapper: createWrapper() })
    expect(screen.getByText('Manual')).toBeInTheDocument()
  })

  it('does not render project/client section when both are null', () => {
    render(
      <SessionDetailPanel
        {...defaultProps}
        projectName={null}
        clientName={null}
      />,
      { wrapper: createWrapper() }
    )
    expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument()
  })

  describe('Prompt Timeline', () => {
    it('shows Prompt Timeline toggle for auto sessions with prompts', () => {
      render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

      expect(screen.getByText('Prompt Timeline')).toBeInTheDocument()
    })

    it('does not show Prompt Timeline for manual sessions', () => {
      const session = { ...baseSession, source: 'manual' as const, promptCount: 0 }
      render(<SessionDetailPanel {...defaultProps} session={session} />, { wrapper: createWrapper() })

      expect(screen.queryByText('Prompt Timeline')).not.toBeInTheDocument()
    })

    it('toggles Prompt Timeline section on click', () => {
      render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

      fireEvent.click(screen.getByText('Prompt Timeline'))

      // Should show loading or content area
      expect(screen.getByText('Loading timings...')).toBeInTheDocument()
    })
  })

})
