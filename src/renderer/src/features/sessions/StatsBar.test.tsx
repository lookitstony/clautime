import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatsBar } from './StatsBar'

const baseProps = {
  humanHours: '1h 30m',
  totalHours: '2h 30m',
  totalSessions: 15,
  totalPrompts: 1234,
  totalTokens: 125000,
  clientCount: 0,
  commitSessions: 0,
  estimatedCost: null,
  isLoading: false
}

describe('StatsBar', () => {
  it('renders stat values', () => {
    render(<StatsBar {...baseProps} />)
    expect(screen.getByText('1h 30m')).toBeInTheDocument()
    expect(screen.getByText('2h 30m')).toBeInTheDocument()
    expect(screen.getByText('15')).toBeInTheDocument()
    expect(screen.getByText('1,234')).toBeInTheDocument()
  })

  it('renders labels', () => {
    render(<StatsBar {...baseProps} />)
    expect(screen.getByText('Human Hours')).toBeInTheDocument()
    expect(screen.getByText('Agent Hours')).toBeInTheDocument()
    expect(screen.getByText('Sessions')).toBeInTheDocument()
    expect(screen.getByText('Prompts')).toBeInTheDocument()
  })

  it('renders skeleton when loading', () => {
    const { container } = render(<StatsBar {...baseProps} isLoading={true} />)
    expect(screen.queryByText('Human Hours')).not.toBeInTheDocument()
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBeGreaterThan(0)
  })

  it('shows client count when clients exist', () => {
    render(<StatsBar {...baseProps} clientCount={3} />)
    expect(screen.getByText('Clients')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('hides client card when no clients', () => {
    render(<StatsBar {...baseProps} clientCount={0} />)
    expect(screen.queryByText('Clients')).not.toBeInTheDocument()
  })

  it('shows estimated cost card when provided', () => {
    render(<StatsBar {...baseProps} estimatedCost="$1,234" />)
    expect(screen.getByText('Est. API Cost')).toBeInTheDocument()
    expect(screen.getByText('$1,234')).toBeInTheDocument()
  })

  it('hides estimated cost card when null', () => {
    render(<StatsBar {...baseProps} estimatedCost={null} />)
    expect(screen.queryByText('Est. API Cost')).not.toBeInTheDocument()
  })
})
