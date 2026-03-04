import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatsBar } from './StatsBar'

describe('StatsBar', () => {
  it('renders stat values', () => {
    render(
      <StatsBar
        todayTotal="2h 30m"
        activeSessions={0}
        totalSessions={15}
        tokensUsed={1234}
        isLoading={false}
      />
    )
    expect(screen.getByText('2h 30m')).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.getByText('15')).toBeInTheDocument()
    expect(screen.getByText('1,234')).toBeInTheDocument()
  })

  it('renders labels', () => {
    render(
      <StatsBar
        todayTotal="0m"
        activeSessions={0}
        totalSessions={0}
        tokensUsed={0}
        isLoading={false}
      />
    )
    expect(screen.getByText("Today's Total")).toBeInTheDocument()
    expect(screen.getByText('Active Sessions')).toBeInTheDocument()
    expect(screen.getByText('Total Sessions')).toBeInTheDocument()
    expect(screen.getByText('Tokens Used')).toBeInTheDocument()
  })

  it('renders skeleton when loading', () => {
    const { container } = render(
      <StatsBar
        todayTotal="0m"
        activeSessions={0}
        totalSessions={0}
        tokensUsed={0}
        isLoading={true}
      />
    )
    // Should not render labels when loading
    expect(screen.queryByText("Today's Total")).not.toBeInTheDocument()
    // Should render skeleton elements
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBeGreaterThan(0)
  })
})
