import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { useIsFirstLaunch, useCompleteSetup } from './use-onboarding'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

beforeEach(() => {
  vi.stubGlobal('api', {
    dialog: {
      openFolder: vi.fn(),
      discoverProjects: vi.fn()
    },
    settings: {
      get: vi.fn().mockResolvedValue({ success: true, data: null }),
      set: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      getAll: vi.fn().mockResolvedValue({ success: true, data: {} })
    },
    sessions: {
      getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
      scan: vi.fn(),
      getById: vi.fn()
    }
  })
})

describe('useIsFirstLaunch', () => {
  it('returns isFirstLaunch true when setup_complete is not set', async () => {
    const { result } = renderHook(() => useIsFirstLaunch(), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.isFirstLaunch).toBe(true)
  })

  it('returns isFirstLaunch false when setup_complete is true', async () => {
    vi.stubGlobal('api', {
      ...window.api,
      settings: {
        ...window.api.settings,
        get: vi.fn().mockResolvedValue({ success: true, data: 'true' })
      }
    })

    const { result } = renderHook(() => useIsFirstLaunch(), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.isFirstLaunch).toBe(false)
  })

  it('returns isLoading true initially', () => {
    const { result } = renderHook(() => useIsFirstLaunch(), { wrapper: createWrapper() })
    expect(result.current.isLoading).toBe(true)
  })
})

describe('useCompleteSetup', () => {
  it('sets setup_complete to true', async () => {
    const { result } = renderHook(() => useCompleteSetup(), { wrapper: createWrapper() })

    await result.current.mutateAsync()

    expect(window.api.settings.set).toHaveBeenCalledWith('setup_complete', 'true')
  })
})
