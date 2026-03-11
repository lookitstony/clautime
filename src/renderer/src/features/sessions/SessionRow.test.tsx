import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionRow } from './SessionRow'
import type { Session } from '../../../../shared/types/session'

const mockSession: Session = {
  id: 1,
  projectPath: '/apps/ClauTime',
  startedAt: '2026-03-04T09:15:00Z',
  endedAt: '2026-03-04T11:42:00Z',
  durationMinutes: 147,
  source: 'auto',
  description: null,
  status: 'completed',
  claudeSessionId: 'abc-123',
  promptCount: 12,
  inputTokens: 0,
  outputTokens: 0,
  sourceFile: '/home/user/.claude/projects/test/session.jsonl',
  projectId: null,
  clientId: null,
  createdAt: '2026-03-04T12:00:00Z',
  updatedAt: '2026-03-04T12:00:00Z'
}

describe('SessionRow', () => {
  const defaultProps = {
    session: mockSession,
    projectColor: '#3b82f6',
    isSelected: false,
    onSelect: vi.fn()
  }

  it('renders time range and duration', () => {
    render(<SessionRow {...defaultProps} />)
    // Duration should be rendered
    expect(screen.getByText('2h 27m')).toBeInTheDocument()
  })

  it('renders Auto badge for auto sessions', () => {
    render(<SessionRow {...defaultProps} />)
    expect(screen.getByText('Auto')).toBeInTheDocument()
  })

  it('renders Manual badge for manual sessions', () => {
    render(
      <SessionRow
        {...defaultProps}
        session={{ ...mockSession, source: 'manual' }}
      />
    )
    expect(screen.getByText('Manual')).toBeInTheDocument()
  })

  it('calls onSelect when clicked', () => {
    const onSelect = vi.fn()
    render(<SessionRow {...defaultProps} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onSelect).toHaveBeenCalled()
  })

  it('calls onSelect on Enter key', () => {
    const onSelect = vi.fn()
    render(<SessionRow {...defaultProps} onSelect={onSelect} />)
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' })
    expect(onSelect).toHaveBeenCalled()
  })

  it('has left border in project color', () => {
    render(<SessionRow {...defaultProps} />)
    const row = screen.getByRole('button')
    expect(row.style.borderLeft).toBe('2px solid #3b82f6')
  })

  it('has aria-expanded attribute', () => {
    render(<SessionRow {...defaultProps} isSelected={true} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  })

  it('displays prompt count when greater than zero', () => {
    render(<SessionRow {...defaultProps} />)
    expect(screen.getByText('12 prompts')).toBeInTheDocument()
  })

  it('hides prompt count when zero', () => {
    render(
      <SessionRow
        {...defaultProps}
        session={{ ...mockSession, promptCount: 0 }}
      />
    )
    expect(screen.queryByText(/prompts?/)).not.toBeInTheDocument()
  })
})
