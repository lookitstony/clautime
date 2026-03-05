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
const mockSplit = vi.fn().mockResolvedValue({ success: true, data: [{}, {}] })
const mockGetAll = vi.fn().mockResolvedValue({ success: true, data: [] })

vi.stubGlobal('window', {
  ...window,
  api: {
    sessions: {
      getPromptTimings: vi.fn().mockResolvedValue({ success: true, data: [] }),
      update: mockUpdate,
      split: mockSplit
    },
    clients: { getAll: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    projects: { getAll: mockGetAll }
  }
})

const baseSession: Session = {
  id: 1,
  projectPath: 'C:\\apps\\ClawdTime',
  startedAt: '2026-03-05T09:15:00.000Z',
  endedAt: '2026-03-05T11:30:00.000Z',
  durationMinutes: 135,
  source: 'auto',
  description: null,
  status: 'completed',
  claudeSessionId: 'abc123',
  promptCount: 24,
  sourceFile: 'test.jsonl',
  projectId: 1,
  clientId: 1,
  createdAt: '2026-03-05T09:15:00.000Z',
  updatedAt: '2026-03-05T11:30:00.000Z'
}

const defaultProps = {
  session: baseSession,
  projectName: 'ClawdTime',
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
    expect(screen.getByText('ClawdTime')).toBeInTheDocument()
  })

  it('shows "No summary available" when description is null', () => {
    render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })
    expect(screen.getByText('No summary available')).toBeInTheDocument()
  })

  it('shows description when present', () => {
    const session = { ...baseSession, description: 'Fixed authentication bug' }
    render(<SessionDetailPanel {...defaultProps} session={session} />, { wrapper: createWrapper() })
    expect(screen.getByText('Fixed authentication bug')).toBeInTheDocument()
    expect(screen.queryByText('No summary available')).not.toBeInTheDocument()
  })

  it('shows enabled Edit Time and Reassign Project buttons for auto sessions', () => {
    render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

    const editBtn = screen.getByRole('button', { name: /edit time/i })
    const reassignBtn = screen.getByRole('button', { name: /reassign project/i })
    expect(editBtn).toBeInTheDocument()
    expect(editBtn).not.toBeDisabled()
    expect(reassignBtn).toBeInTheDocument()
    expect(reassignBtn).not.toBeDisabled()
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
    expect(screen.queryByRole('button', { name: /reassign project/i })).not.toBeInTheDocument()
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

  describe('Edit Time', () => {
    it('shows time inputs when Edit Time is clicked', () => {
      render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

      fireEvent.click(screen.getByRole('button', { name: /edit time/i }))

      const inputs = screen.getAllByPlaceholderText('HH:MM:SS')
      expect(inputs).toHaveLength(2)
      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    })

    it('cancels edit mode when Cancel is clicked', () => {
      render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

      fireEvent.click(screen.getByRole('button', { name: /edit time/i }))
      expect(screen.getAllByPlaceholderText('HH:MM:SS')).toHaveLength(2)

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
      expect(screen.queryByPlaceholderText('HH:MM:SS')).not.toBeInTheDocument()
    })

    it('cancels edit mode when Escape is pressed in edit mode', () => {
      render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

      fireEvent.click(screen.getByRole('button', { name: /edit time/i }))
      const panel = screen.getByRole('region')
      fireEvent.keyDown(panel, { key: 'Escape' })

      // Should cancel edit mode, NOT close the panel
      expect(screen.queryByPlaceholderText('HH:MM:SS')).not.toBeInTheDocument()
      expect(defaultProps.onClose).not.toHaveBeenCalled()
    })
  })

  describe('Split Session', () => {
    it('shows Split Session button for auto sessions', () => {
      render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })
      expect(screen.getByRole('button', { name: /split session/i })).toBeInTheDocument()
    })

    it('shows split UI when Split Session is clicked', () => {
      render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

      fireEvent.click(screen.getByRole('button', { name: /split session/i }))

      expect(screen.getByPlaceholderText('HH:MM:SS')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /split here/i })).toBeInTheDocument()
    })

    it('shows duration preview for valid split point', () => {
      render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

      fireEvent.click(screen.getByRole('button', { name: /split session/i }))
      // The default split is at the midpoint, so preview should render
      expect(screen.getByText(/Session 1:/)).toBeInTheDocument()
      expect(screen.getByText(/Session 2:/)).toBeInTheDocument()
    })

    it('cancels split when Cancel is clicked', () => {
      render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

      fireEvent.click(screen.getByRole('button', { name: /split session/i }))
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

      // Split UI should be gone — no "Split Here" button
      expect(screen.queryByRole('button', { name: /split here/i })).not.toBeInTheDocument()
    })

    it('disables Split Session button for very short sessions', () => {
      const session = { ...baseSession, durationMinutes: 1 }
      render(<SessionDetailPanel {...defaultProps} session={session} />, { wrapper: createWrapper() })
      expect(screen.getByRole('button', { name: /split session/i })).toBeDisabled()
    })
  })

  describe('Reassign Project', () => {
    it('shows project dropdown when Reassign Project is clicked', () => {
      render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

      fireEvent.click(screen.getByRole('button', { name: /reassign project/i }))

      // The reassign dropdown should appear with a cancel button
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    })

    it('cancels reassign mode on cancel click', () => {
      render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

      fireEvent.click(screen.getByRole('button', { name: /reassign project/i }))
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

      // Should show original client/project names again
      expect(screen.getByText('Acme Corp')).toBeInTheDocument()
      expect(screen.getByText('ClawdTime')).toBeInTheDocument()
    })
  })
})
