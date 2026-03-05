import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionDetailPanel } from './SessionDetailPanel'
import type { Session } from '../../../../shared/types/session'

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

  it('shows Edit Time and Reassign Project buttons for auto sessions', () => {
    render(<SessionDetailPanel {...defaultProps} />, { wrapper: createWrapper() })

    const editBtn = screen.getByRole('button', { name: /edit time/i })
    const reassignBtn = screen.getByRole('button', { name: /reassign project/i })
    expect(editBtn).toBeInTheDocument()
    expect(editBtn).toBeDisabled()
    expect(reassignBtn).toBeInTheDocument()
    expect(reassignBtn).toBeDisabled()

    // Should NOT show manual-only buttons
    expect(screen.queryByRole('button', { name: /edit description/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument()
  })

  it('shows Edit Description and Delete buttons for manual sessions', () => {
    const session = { ...baseSession, source: 'manual' as const }
    render(<SessionDetailPanel {...defaultProps} session={session} />, { wrapper: createWrapper() })

    const editDescBtn = screen.getByRole('button', { name: /edit description/i })
    const deleteBtn = screen.getByRole('button', { name: /^delete$/i })
    expect(editDescBtn).toBeInTheDocument()
    expect(editDescBtn).toBeDisabled()
    expect(deleteBtn).toBeInTheDocument()
    expect(deleteBtn).toBeDisabled()

    // Should NOT show auto-only buttons
    expect(screen.queryByRole('button', { name: /edit time/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reassign project/i })).not.toBeInTheDocument()
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
})
