import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Activity } from 'lucide-react'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('renders icon, title, and description', () => {
    render(
      <EmptyState
        icon={Activity}
        title="No Active Sessions"
        description="Running sessions will appear here"
      />
    )
    expect(screen.getByText('No Active Sessions')).toBeInTheDocument()
    expect(screen.getByText('Running sessions will appear here')).toBeInTheDocument()
  })

  it('renders optional action', () => {
    render(
      <EmptyState
        icon={Activity}
        title="Empty"
        description="desc"
        action={<button>Do something</button>}
      />
    )
    expect(screen.getByRole('button', { name: 'Do something' })).toBeInTheDocument()
  })

  it('does not render action section when no action prop', () => {
    const { container } = render(<EmptyState icon={Activity} title="Empty" description="desc" />)
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})
