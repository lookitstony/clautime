import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionDetailPanel } from './SessionDetailPanel'
import type { Session } from '../../../../shared/types/session'
import { toast } from 'sonner'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// Mock browser APIs for Radix components
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)
// Radix Select accesses window.HTMLSelectElement.prototype — mock for happy-dom
const HtmlSelectProto = {} as any
Object.defineProperty(HtmlSelectProto, 'value', {
  get() {
    return ''
  },
  set(_v: string) {},
  configurable: true,
  enumerable: true
})
vi.stubGlobal('HTMLSelectElement', { prototype: HtmlSelectProto })

// Mock window.api
const mockDelete = vi.fn().mockResolvedValue({ success: true })
const mockSplit = vi.fn().mockResolvedValue({ success: true, data: [] })
const mockUpdate = vi.fn().mockResolvedValue({ success: true, data: {} })

vi.stubGlobal('window', {
  ...window,
  api: {
    sessions: {
      getPromptTimings: vi.fn().mockResolvedValue({ success: true, data: [] }),
      update: mockUpdate,
      delete: mockDelete,
      split: mockSplit
    },
    git: { getCommitsForSession: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    ai: {
      getSummary: vi.fn().mockResolvedValue({ success: true, data: { summary: '', tier: 'none' } })
    }
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
  tool: 'claude',
  claudeSessionId: 'abc123',
  promptCount: 24,
  inputTokens: 50000,
  outputTokens: 75000,
  sourceFile: 'test.jsonl',
  billable: true,
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

  it('offers history deletion for auto sessions', () => {
    render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

    // Description editing remains manual-only.
    expect(screen.queryByRole('button', { name: /edit description/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^delete from history$/i })).toBeEnabled()
  })

  it('shows enabled Edit Description and Delete buttons for manual sessions', () => {
    const session = { ...baseSession, source: 'manual' as const }
    render(<SessionDetailPanel {...defaultProps} session={session} />, { wrapper: createWrapper() })

    const editDescBtn = screen.getByRole('button', { name: /edit description/i })
    const deleteBtn = screen.getByRole('button', { name: /^delete from history$/i })
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
      render(<SessionDetailPanel {...defaultProps} session={session} />, {
        wrapper: createWrapper()
      })

      fireEvent.click(screen.getByRole('button', { name: /edit description/i }))

      const textarea = screen.getByRole('textbox')
      expect(textarea).toBeInTheDocument()
      expect(textarea).toHaveValue('Test desc')
    })

    it('shows delete confirmation when Delete is clicked', () => {
      const session = { ...baseSession, source: 'manual' as const }
      render(<SessionDetailPanel {...defaultProps} session={session} />, {
        wrapper: createWrapper()
      })

      fireEvent.click(screen.getByRole('button', { name: /^delete from history$/i }))

      expect(
        screen.getByText(
          'Delete from history? Rescans will keep it deleted. Saved invoices are preserved.'
        )
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /confirm/i })).toBeInTheDocument()
    })

    it('cancels delete confirmation', () => {
      const session = { ...baseSession, source: 'manual' as const }
      render(<SessionDetailPanel {...defaultProps} session={session} />, {
        wrapper: createWrapper()
      })

      fireEvent.click(screen.getByRole('button', { name: /^delete from history$/i }))
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

      expect(
        screen.queryByText(
          'Delete from history? Rescans will keep it deleted. Saved invoices are preserved.'
        )
      ).not.toBeInTheDocument()
    })
  })

  it('requires confirmation before deleting automatic history', async () => {
    const { container } = render(<SessionDetailPanel {...defaultProps} />, {
      wrapper: createWrapper()
    })
    fireEvent.click(screen.getByRole('button', { name: /^delete from history$/i }))
    expect(mockDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(baseSession.id), { container })
    await waitFor(() => expect(defaultProps.onClose).toHaveBeenCalledTimes(1), { container })
  })

  it('shows a rejected deletion and keeps the session open', async () => {
    mockDelete.mockResolvedValueOnce({
      success: false,
      error: { message: 'Resolve activity mapping first' }
    })
    const { container } = render(<SessionDetailPanel {...defaultProps} />, {
      wrapper: createWrapper()
    })
    fireEvent.click(screen.getByRole('button', { name: /^delete from history$/i }))
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    await waitFor(
      () => expect(toast.error).toHaveBeenCalledWith('Resolve activity mapping first'),
      { container }
    )
    expect(defaultProps.onClose).not.toHaveBeenCalled()
  })

  it('previews and confirms a split using elapsed time from the session start', async () => {
    const { container } = render(<SessionDetailPanel {...defaultProps} />, {
      wrapper: createWrapper()
    })
    fireEvent.click(screen.getByRole('button', { name: /^split session$/i }))
    expect(mockSplit).not.toHaveBeenCalled()
    expect(screen.getByText(/Prompts and tokens are divided proportionally/)).toBeInTheDocument()
    expect(screen.getByText(/Older sessions use saved history/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /confirm split/i }))
    await waitFor(
      () => expect(mockSplit).toHaveBeenCalledWith(baseSession.id, '2026-03-05T10:22:30.000Z'),
      { container }
    )
    await waitFor(() => expect(defaultProps.onClose).toHaveBeenCalledTimes(1), { container })
  })

  it('rejects a split outside the interval before IPC', () => {
    render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByRole('button', { name: /^split session$/i }))
    fireEvent.change(screen.getByLabelText('Split after (minutes)'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: /confirm split/i }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a point inside the session.')
    expect(mockSplit).not.toHaveBeenCalled()
  })

  it('cancels a split with Escape without closing the session', () => {
    render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })
    fireEvent.click(screen.getByRole('button', { name: /^split session$/i }))
    fireEvent.keyDown(screen.getByRole('region'), { key: 'Escape' })
    expect(screen.getByRole('button', { name: /^split session$/i })).toBeInTheDocument()
    expect(mockSplit).not.toHaveBeenCalled()
    expect(defaultProps.onClose).not.toHaveBeenCalled()
  })

  it('keeps split mapping failures visible without closing the session', async () => {
    mockSplit.mockResolvedValueOnce({
      success: false,
      error: { message: 'Resolve activity mapping first' }
    })
    const { container } = render(<SessionDetailPanel {...defaultProps} />, {
      wrapper: createWrapper()
    })
    fireEvent.click(screen.getByRole('button', { name: /^split session$/i }))
    fireEvent.click(screen.getByRole('button', { name: /confirm split/i }))
    await waitFor(
      () => expect(screen.getByRole('alert')).toHaveTextContent('Resolve activity mapping first'),
      { container }
    )
    expect(defaultProps.onClose).not.toHaveBeenCalled()
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
    render(<SessionDetailPanel {...defaultProps} projectName={null} clientName={null} />, {
      wrapper: createWrapper()
    })
    expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument()
  })

  describe('Prompt Timeline', () => {
    it('shows Prompt Timeline toggle for auto sessions with prompts', () => {
      render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

      expect(screen.getByText('Prompt Timeline')).toBeInTheDocument()
    })

    it('does not show Prompt Timeline for manual sessions', () => {
      const session = { ...baseSession, source: 'manual' as const, promptCount: 0 }
      render(<SessionDetailPanel {...defaultProps} session={session} />, {
        wrapper: createWrapper()
      })

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
