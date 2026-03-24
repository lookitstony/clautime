import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import {
  useProjects,
  useCreateProject,
  useUpdateProject,
  useDeleteProject,
  useAttributeSessions
} from './use-projects'
import type { Project } from '../../../../shared/types/client-project'

const mockProjects: Project[] = [
  {
    id: 1,
    clientId: 1,
    name: 'ClauTime',
    invoiceName: null,
    directoryPath: 'C:\\apps\\ClauTime',
    isBillable: true,
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
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn()
    },
    projects: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: mockProjects }),
      create: vi.fn().mockResolvedValue({ success: true, data: mockProjects[0] }),
      update: vi.fn().mockResolvedValue({
        success: true,
        data: { ...mockProjects[0], name: 'Updated' }
      }),
      delete: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      attributeSessions: vi.fn().mockResolvedValue({ success: true, data: 3 })
    },
    sessions: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      scan: vi.fn(),
      reset: vi.fn(),
      getById: vi.fn()
    }
  })
})

describe('useProjects', () => {
  it('fetches all projects', async () => {
    const { result } = renderHook(() => useProjects(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(mockProjects)
  })

  it('fetches projects filtered by clientId', async () => {
    const { result } = renderHook(() => useProjects(1), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(window.api.projects.getAll).toHaveBeenCalledWith(1)
  })

  it('handles error', async () => {
    vi.stubGlobal('api', {
      ...window.api,
      projects: {
        ...window.api.projects,
        getAll: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'ERR', message: 'Failed' }
        })
      }
    })
    const { result } = renderHook(() => useProjects(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})

describe('useCreateProject', () => {
  it('creates a project', async () => {
    const { result } = renderHook(() => useCreateProject(), { wrapper: createWrapper() })
    await result.current.mutateAsync({
      clientId: 1,
      name: 'NewProj',
      directoryPath: 'C:\\new'
    })
    expect(window.api.projects.create).toHaveBeenCalledWith({
      clientId: 1,
      name: 'NewProj',
      directoryPath: 'C:\\new'
    })
  })
})

describe('useUpdateProject', () => {
  it('updates a project', async () => {
    const { result } = renderHook(() => useUpdateProject(), { wrapper: createWrapper() })
    await result.current.mutateAsync({ id: 1, data: { name: 'Updated' } })
    expect(window.api.projects.update).toHaveBeenCalledWith(1, { name: 'Updated' })
  })
})

describe('useDeleteProject', () => {
  it('deletes a project', async () => {
    const { result } = renderHook(() => useDeleteProject(), { wrapper: createWrapper() })
    await result.current.mutateAsync(1)
    expect(window.api.projects.delete).toHaveBeenCalledWith(1)
  })
})

describe('useAttributeSessions', () => {
  it('attributes sessions and returns count', async () => {
    const { result } = renderHook(() => useAttributeSessions(), { wrapper: createWrapper() })
    const count = await result.current.mutateAsync()
    expect(count).toBe(3)
    expect(window.api.projects.attributeSessions).toHaveBeenCalled()
  })
})
