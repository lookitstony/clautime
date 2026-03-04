import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectGroup } from './ProjectGroup'

describe('ProjectGroup', () => {
  const defaultProps = {
    projectName: 'ClawdTime',
    projectColor: '#3b82f6',
    sessionCount: 5,
    totalDurationMinutes: 125,
    isExpanded: false,
    onToggle: vi.fn(),
    children: <div data-testid="child-content">Sessions here</div>
  }

  it('renders project name and stats', () => {
    render(<ProjectGroup {...defaultProps} />)
    expect(screen.getByText('ClawdTime')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText('2h 5m')).toBeInTheDocument()
  })

  it('hides children when collapsed', () => {
    render(<ProjectGroup {...defaultProps} isExpanded={false} />)
    // Collapsible removes content from DOM when closed
    expect(screen.queryByTestId('child-content')).not.toBeInTheDocument()
  })

  it('shows children when expanded', () => {
    render(<ProjectGroup {...defaultProps} isExpanded={true} />)
    expect(screen.getByTestId('child-content')).toBeVisible()
  })

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn()
    render(<ProjectGroup {...defaultProps} onToggle={onToggle} />)
    fireEvent.click(screen.getByText('ClawdTime'))
    expect(onToggle).toHaveBeenCalled()
  })

  it('calls onToggle on Enter key', () => {
    const onToggle = vi.fn()
    render(<ProjectGroup {...defaultProps} onToggle={onToggle} />)
    const group = screen.getByRole('group')
    fireEvent.keyDown(group, { key: 'Enter' })
    expect(onToggle).toHaveBeenCalled()
  })

  it('calls onToggle on Space key', () => {
    const onToggle = vi.fn()
    render(<ProjectGroup {...defaultProps} onToggle={onToggle} />)
    const group = screen.getByRole('group')
    fireEvent.keyDown(group, { key: ' ' })
    expect(onToggle).toHaveBeenCalled()
  })

  it('has correct aria-label', () => {
    render(<ProjectGroup {...defaultProps} />)
    const group = screen.getByRole('group')
    expect(group).toHaveAttribute(
      'aria-label',
      'ClawdTime - 5 sessions, 2h 5m total'
    )
  })

  it('sets aria-expanded correctly', () => {
    const { rerender } = render(<ProjectGroup {...defaultProps} isExpanded={false} />)
    expect(screen.getByRole('group')).toHaveAttribute('aria-expanded', 'false')

    rerender(<ProjectGroup {...defaultProps} isExpanded={true} />)
    expect(screen.getByRole('group')).toHaveAttribute('aria-expanded', 'true')
  })
})
