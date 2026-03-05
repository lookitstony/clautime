import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ClientCard } from './ClientCard'
import type { Client } from '../../../../shared/types/client-project'

const mockClient: Client = {
  id: 1,
  name: 'Acme Corp',
  color: 'var(--project-1)',
  billableRate: null,
  isActive: true,
  createdAt: '2026-03-04T00:00:00.000Z',
  updatedAt: '2026-03-04T00:00:00.000Z'
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
  vi.stubGlobal('api', {
    clients: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [mockClient] }),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue({ success: true, data: undefined })
    },
    projects: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      attributeSessions: vi.fn()
    },
    sessions: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] })
    },
    dialog: {
      openFolder: vi.fn().mockResolvedValue({ success: true, data: null })
    }
  })
})

describe('ClientCard', () => {
  it('renders client name and color dot', () => {
    render(
      <ClientCard
        client={mockClient}
        isExpanded={false}
        onToggle={vi.fn()}
        onEdit={vi.fn()}
      />,
      { wrapper: createWrapper() }
    )
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    // Color dot should exist with the right background
    const colorDot = document.querySelector('[style*="background-color"]')
    expect(colorDot).toBeInTheDocument()
  })

  it('shows project count badge', async () => {
    render(
      <ClientCard
        client={mockClient}
        isExpanded={false}
        onToggle={vi.fn()}
        onEdit={vi.fn()}
      />,
      { wrapper: createWrapper() }
    )
    await waitFor(() => {
      expect(screen.getByText('0 projects')).toBeInTheDocument()
    })
  })

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn()
    render(
      <ClientCard
        client={mockClient}
        isExpanded={false}
        onToggle={onToggle}
        onEdit={vi.fn()}
      />,
      { wrapper: createWrapper() }
    )
    fireEvent.click(screen.getByText('Acme Corp'))
    expect(onToggle).toHaveBeenCalled()
  })

  it('calls onEdit when edit button clicked', () => {
    const onEdit = vi.fn()
    render(
      <ClientCard
        client={mockClient}
        isExpanded={false}
        onToggle={vi.fn()}
        onEdit={onEdit}
      />,
      { wrapper: createWrapper() }
    )
    fireEvent.click(screen.getByLabelText('Edit Acme Corp'))
    expect(onEdit).toHaveBeenCalled()
  })

  it('shows delete confirmation dialog when delete button clicked', async () => {
    render(
      <ClientCard
        client={mockClient}
        isExpanded={false}
        onToggle={vi.fn()}
        onEdit={vi.fn()}
      />,
      { wrapper: createWrapper() }
    )
    fireEvent.click(screen.getByLabelText('Delete Acme Corp'))
    await waitFor(() => {
      expect(screen.getByText(/Delete client/)).toBeInTheDocument()
      expect(screen.getByText(/This will also remove all projects/)).toBeInTheDocument()
    })
  })

  it('shows ProjectList when expanded', async () => {
    render(
      <ClientCard
        client={mockClient}
        isExpanded={true}
        onToggle={vi.fn()}
        onEdit={vi.fn()}
      />,
      { wrapper: createWrapper() }
    )
    await waitFor(() => {
      expect(screen.getByText('No projects yet')).toBeInTheDocument()
    })
    expect(screen.getByText('+ Assign Projects')).toBeInTheDocument()
    expect(screen.getByText('+ Add Manually')).toBeInTheDocument()
  })
})
