import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ClientForm } from './ClientForm'
import type { Client } from '../../../../shared/types/client-project'

const mockClient: Client = {
  id: 1,
  name: 'Acme Corp',
  color: 'var(--project-1)',
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
      create: vi.fn().mockResolvedValue({ success: true, data: mockClient }),
      update: vi.fn().mockResolvedValue({ success: true, data: { ...mockClient, name: 'Updated' } }),
      delete: vi.fn()
    },
    projects: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      attributeSessions: vi.fn()
    }
  })
})

describe('ClientForm', () => {
  it('renders create mode with empty fields', () => {
    render(
      <ClientForm open={true} onClose={vi.fn()} client={null} />,
      { wrapper: createWrapper() }
    )
    expect(screen.getByText('Add Client')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Client name')).toHaveValue('')
  })

  it('renders edit mode with pre-filled values', () => {
    render(
      <ClientForm open={true} onClose={vi.fn()} client={mockClient} />,
      { wrapper: createWrapper() }
    )
    expect(screen.getByText('Edit Client')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Client name')).toHaveValue('Acme Corp')
  })

  it('submit button disabled when name is empty', () => {
    render(
      <ClientForm open={true} onClose={vi.fn()} client={null} />,
      { wrapper: createWrapper() }
    )
    const createButton = screen.getByRole('button', { name: 'Create Client' })
    expect(createButton).toBeDisabled()
  })

  it('calls create mutation on submit', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(
      <ClientForm open={true} onClose={onClose} client={null} />,
      { wrapper: createWrapper() }
    )

    await user.type(screen.getByPlaceholderText('Client name'), 'New Client')
    await user.click(screen.getByRole('button', { name: 'Create Client' }))

    await waitFor(() => {
      expect(window.api.clients.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'New Client' })
      )
    })
  })

  it('renders color picker with 8 swatches', () => {
    render(
      <ClientForm open={true} onClose={vi.fn()} client={null} />,
      { wrapper: createWrapper() }
    )
    const swatches = screen.getAllByRole('button', { name: /Select color / })
    expect(swatches).toHaveLength(8)
  })

  it('selects a color when swatch clicked', async () => {
    const user = userEvent.setup()
    render(
      <ClientForm open={true} onClose={vi.fn()} client={null} />,
      { wrapper: createWrapper() }
    )
    const swatches = screen.getAllByRole('button', { name: /Select color / })
    await user.click(swatches[2]) // Click 3rd color

    // The clicked swatch should now show a checkmark (Check icon)
    // The first swatch should no longer show it
    const svg = swatches[2].querySelector('svg')
    expect(svg).toBeInTheDocument()
  })
})
