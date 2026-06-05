import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { useClients, useCreateClient, useUpdateClient, useDeleteClient } from './use-clients'
import type { Client } from '../../../../shared/types/client-project'

const mockClients: Client[] = [
  {
    id: 1,
    name: 'Acme Corp',
    color: 'var(--project-1)',
    billableRate: null,
    email: null,
    stripeCustomerId: null,
    isActive: true,
    createdAt: '2026-03-04T00:00:00.000Z',
    updatedAt: '2026-03-04T00:00:00.000Z'
  },
  {
    id: 2,
    name: 'Beta Inc',
    color: 'var(--project-2)',
    billableRate: null,
    email: null,
    stripeCustomerId: null,
    isActive: true,
    createdAt: '2026-03-04T00:00:00.000Z',
    updatedAt: '2026-03-04T00:00:00.000Z'
  }
]

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

beforeEach(() => {
  vi.stubGlobal('api', {
    clients: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: mockClients }),
      create: vi.fn().mockResolvedValue({ success: true, data: mockClients[0] }),
      update: vi
        .fn()
        .mockResolvedValue({ success: true, data: { ...mockClients[0], name: 'Updated' } }),
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
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      scan: vi.fn(),
      reset: vi.fn(),
      getById: vi.fn()
    }
  })
})

describe('useClients', () => {
  it('fetches clients successfully', async () => {
    const { result } = renderHook(() => useClients(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(mockClients)
  })

  it('handles error from API', async () => {
    vi.stubGlobal('api', {
      ...window.api,
      clients: {
        ...window.api.clients,
        getAll: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'ERR', message: 'Failed to fetch' }
        })
      }
    })
    const { result } = renderHook(() => useClients(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('Failed to fetch')
  })
})

describe('useCreateClient', () => {
  it('creates a client and invalidates cache', async () => {
    const { result } = renderHook(() => useCreateClient(), { wrapper: createWrapper() })
    await result.current.mutateAsync({ name: 'New Client' })
    expect(window.api.clients.create).toHaveBeenCalledWith({ name: 'New Client' })
  })
})

describe('useUpdateClient', () => {
  it('updates a client', async () => {
    const { result } = renderHook(() => useUpdateClient(), { wrapper: createWrapper() })
    await result.current.mutateAsync({ id: 1, data: { name: 'Updated' } })
    expect(window.api.clients.update).toHaveBeenCalledWith(1, { name: 'Updated' })
  })
})

describe('useDeleteClient', () => {
  it('deletes a client', async () => {
    const { result } = renderHook(() => useDeleteClient(), { wrapper: createWrapper() })
    await result.current.mutateAsync(1)
    expect(window.api.clients.delete).toHaveBeenCalledWith(1)
  })
})
