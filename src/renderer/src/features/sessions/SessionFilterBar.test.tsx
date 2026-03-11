import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SessionFilterBar } from './SessionFilterBar'
import { useFilterStore } from '@/stores/use-filter-store'

const mockClients = [
  { id: 1, name: 'Acme Corp', color: 'var(--project-1)', billableRate: null, isActive: true, createdAt: '', updatedAt: '' },
  { id: 2, name: 'Beta Inc', color: 'var(--project-2)', billableRate: null, isActive: true, createdAt: '', updatedAt: '' }
]

const mockProjects = [
  { id: 1, clientId: 1, name: 'ClauTime', directoryPath: 'C:\\apps\\ClauTime', isBillable: true, isActive: true, createdAt: '', updatedAt: '' },
  { id: 2, clientId: 2, name: 'OtherApp', directoryPath: 'C:\\apps\\OtherApp', isBillable: true, isActive: true, createdAt: '', updatedAt: '' }
]

beforeEach(() => {
  useFilterStore.getState().clearFilters()
})

describe('SessionFilterBar', () => {
  it('renders date preset buttons', () => {
    render(<SessionFilterBar clients={[]} projects={[]} />)
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'This Week' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Last Week' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'This Month' })).toBeInTheDocument()
  })

  it('renders Custom date button', () => {
    render(<SessionFilterBar clients={[]} projects={[]} />)
    expect(screen.getByRole('button', { name: /custom/i })).toBeInTheDocument()
  })

  it('clicking a preset toggles it in the store', () => {
    render(<SessionFilterBar clients={[]} projects={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(useFilterStore.getState().datePreset).toBe('today')
    // Click again to deselect
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(useFilterStore.getState().datePreset).toBeNull()
  })

  it('marks active preset with aria-pressed', () => {
    useFilterStore.getState().setDatePreset('this-week')
    render(<SessionFilterBar clients={[]} projects={[]} />)
    expect(screen.getByRole('button', { name: 'This Week' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('hides client dropdown when no clients', () => {
    render(<SessionFilterBar clients={[]} projects={[]} />)
    expect(screen.queryByLabelText('Filter by client')).not.toBeInTheDocument()
  })

  it('shows client dropdown when clients exist', () => {
    render(<SessionFilterBar clients={mockClients} projects={mockProjects} />)
    expect(screen.getByLabelText('Filter by client')).toBeInTheDocument()
  })

  it('hides project dropdown when no projects', () => {
    render(<SessionFilterBar clients={[]} projects={[]} />)
    expect(screen.queryByLabelText('Filter by project')).not.toBeInTheDocument()
  })

  it('shows project dropdown when projects exist', () => {
    render(<SessionFilterBar clients={mockClients} projects={mockProjects} />)
    expect(screen.getByLabelText('Filter by project')).toBeInTheDocument()
  })

  it('shows clear button only when filters are active', () => {
    const { rerender } = render(<SessionFilterBar clients={[]} projects={[]} />)
    expect(screen.queryByLabelText('Clear all filters')).not.toBeInTheDocument()

    useFilterStore.getState().setDatePreset('today')
    rerender(<SessionFilterBar clients={[]} projects={[]} />)
    expect(screen.getByLabelText('Clear all filters')).toBeInTheDocument()
  })

  it('clear button resets all filters', () => {
    useFilterStore.getState().setDatePreset('today')
    useFilterStore.getState().setClientId(1)
    render(<SessionFilterBar clients={mockClients} projects={mockProjects} />)
    fireEvent.click(screen.getByLabelText('Clear all filters'))
    const state = useFilterStore.getState()
    expect(state.datePreset).toBeNull()
    expect(state.clientId).toBeNull()
  })

  it('has toolbar role with label', () => {
    render(<SessionFilterBar clients={[]} projects={[]} />)
    expect(screen.getByRole('toolbar', { name: 'Session filters' })).toBeInTheDocument()
  })
})
