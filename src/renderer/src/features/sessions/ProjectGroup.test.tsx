import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProjectGroup } from './ProjectGroup'

describe('ProjectGroup', () => {
  const defaultProps = {
    projectName: 'ClauTime',
    projectColor: '#3b82f6',
    sessionCount: 5,
    totalDurationMinutes: 125,
    totalPrompts: 42,
    totalTokens: 50000,
    isExpanded: false,
    onToggle: vi.fn(),
    children: <div data-testid="child-content">Sessions here</div>
  }

  it('renders project name and stats', () => {
    render(<ProjectGroup {...defaultProps} />)
    expect(screen.getByText('ClauTime')).toBeInTheDocument()
    expect(screen.getByText('5 sessions')).toBeInTheDocument()
    expect(screen.getByText('42 prompts')).toBeInTheDocument()
    expect(screen.getByText('2h 5m')).toBeInTheDocument()
  })

  it('hides children when collapsed', () => {
    render(<ProjectGroup {...defaultProps} isExpanded={false} />)
    expect(screen.queryByTestId('child-content')).not.toBeInTheDocument()
  })

  it('shows children when expanded', () => {
    render(<ProjectGroup {...defaultProps} isExpanded={true} />)
    expect(screen.getByTestId('child-content')).toBeVisible()
  })

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn()
    render(<ProjectGroup {...defaultProps} onToggle={onToggle} />)
    fireEvent.click(screen.getByText('ClauTime'))
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

  it('has correct aria-label without client name', () => {
    render(<ProjectGroup {...defaultProps} />)
    const group = screen.getByRole('group')
    expect(group).toHaveAttribute(
      'aria-label',
      'ClauTime - 5 sessions, 2h 5m total'
    )
  })

  it('sets aria-expanded correctly', () => {
    const { rerender } = render(<ProjectGroup {...defaultProps} isExpanded={false} />)
    expect(screen.getByRole('group')).toHaveAttribute('aria-expanded', 'false')

    rerender(<ProjectGroup {...defaultProps} isExpanded={true} />)
    expect(screen.getByRole('group')).toHaveAttribute('aria-expanded', 'true')
  })

  it('displays client name when provided', () => {
    render(<ProjectGroup {...defaultProps} clientName="Acme Corp" />)
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText('ClauTime')).toBeInTheDocument()
  })

  it('includes client name in aria-label when provided', () => {
    render(<ProjectGroup {...defaultProps} clientName="Acme Corp" />)
    const group = screen.getByRole('group')
    expect(group).toHaveAttribute(
      'aria-label',
      'Acme Corp / ClauTime - 5 sessions, 2h 5m total'
    )
  })

  it('renders separator between client name and project name', () => {
    render(<ProjectGroup {...defaultProps} clientName="Acme Corp" />)
    expect(screen.getByText('/')).toBeInTheDocument()
  })

  it('uses muted color dot for unassigned groups', () => {
    const { container } = render(
      <ProjectGroup {...defaultProps} isUnassigned={true} />
    )
    const dot = container.querySelector('.rounded-full')
    expect(dot).toHaveClass('opacity-40')
  })

  it('includes (Unassigned) in aria-label for unassigned groups', () => {
    render(<ProjectGroup {...defaultProps} isUnassigned={true} />)
    const group = screen.getByRole('group')
    expect(group).toHaveAttribute(
      'aria-label',
      'ClauTime (Unassigned) - 5 sessions, 2h 5m total'
    )
  })

  it('does not show opacity on assigned groups', () => {
    const { container } = render(
      <ProjectGroup {...defaultProps} isUnassigned={false} />
    )
    const dot = container.querySelector('.rounded-full')
    expect(dot).not.toHaveClass('opacity-40')
  })
})
