import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { useAnalyticsData, useDashboardLayout } from '../use-analytics'
import { DEFAULT_LAYOUT } from '../widget-registry'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

const mockSession = {
  date: 'Mon, Mar 3, 2026',
  projectName: 'ClawdTime',
  clientName: 'Acme',
  startedAt: '2026-03-03T09:00:00.000Z',
  endedAt: '2026-03-03T10:00:00.000Z',
  durationMinutes: 60,
  promptCount: 10,
  inputTokens: 5000,
  outputTokens: 3000,
  description: null,
  source: 'auto' as const
}

const mockSummary = {
  totalSessions: 1,
  totalDurationMinutes: 60,
  totalPrompts: 10,
  totalInputTokens: 5000,
  totalOutputTokens: 3000,
  totalBilledCost: 100,
  billedByClient: [{ clientName: 'Acme', hours: 1, rate: 100, cost: 100 }]
}

beforeEach(() => {
  vi.stubGlobal('api', {
    reports: {
      generate: vi.fn().mockResolvedValue({
        success: true,
        data: {
          format: 'session-breakdown',
          filters: { startDate: '', endDate: '' },
          generatedAt: new Date().toISOString(),
          summary: mockSummary,
          sessionBreakdown: [mockSession]
        }
      })
    },
    settings: {
      get: vi.fn().mockResolvedValue({ success: true, data: null }),
      set: vi.fn().mockResolvedValue({ success: true, data: undefined })
    }
  })
})

describe('useAnalyticsData', () => {
  it('fetches session-breakdown format via single IPC call', async () => {
    const filters = { startDate: '2026-03-01T00:00:00Z', endDate: '2026-03-07T23:59:59Z' }
    const { result } = renderHook(() => useAnalyticsData(filters), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.sessionData).toHaveLength(1)
    })
    expect(window.api.reports.generate).toHaveBeenCalledWith(filters, 'session-breakdown')
    expect(window.api.reports.generate).toHaveBeenCalledTimes(1)
    expect(result.current.summaryData).toEqual(mockSummary)
  })

  it('does not fetch when filters is null', async () => {
    const { result } = renderHook(() => useAnalyticsData(null), { wrapper: createWrapper() })

    // Wait a tick to ensure no fetch happens
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.sessionData).toEqual([])
    expect(result.current.summaryData).toBeNull()
    expect(window.api.reports.generate).not.toHaveBeenCalled()
  })

  it('throws on IPC error', async () => {
    vi.mocked(window.api.reports.generate).mockResolvedValue({
      success: false,
      error: { message: 'DB error' }
    } as any)

    const filters = { startDate: '2026-03-01T00:00:00Z', endDate: '2026-03-07T23:59:59Z' }
    const { result } = renderHook(() => useAnalyticsData(filters), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })
  })
})

describe('useDashboardLayout', () => {
  it('falls back to DEFAULT_LAYOUT when no saved layout', async () => {
    const { result } = renderHook(() => useDashboardLayout(), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.layout.widgets).toHaveLength(8)
    })
    expect(result.current.layout).toEqual(DEFAULT_LAYOUT)
  })

  it('parses saved layout from settings', async () => {
    const savedLayout = { widgets: [{ id: 'daily-hours', size: 'large' }] }
    vi.mocked(window.api.settings.get).mockResolvedValue({
      success: true,
      data: JSON.stringify(savedLayout)
    } as any)

    const { result } = renderHook(() => useDashboardLayout(), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.layout.widgets).toHaveLength(1)
    })
    expect(result.current.layout.widgets[0].id).toBe('daily-hours')
    expect(result.current.layout.widgets[0].size).toBe('large')
  })

  it('falls back to DEFAULT_LAYOUT on invalid JSON', async () => {
    vi.mocked(window.api.settings.get).mockResolvedValue({
      success: true,
      data: 'not-json'
    } as any)

    const { result } = renderHook(() => useDashboardLayout(), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.layout).toEqual(DEFAULT_LAYOUT)
    })
  })

  it('toggleWidget removes existing widget', async () => {
    const { result } = renderHook(() => useDashboardLayout(), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.layout.widgets).toHaveLength(8)
    })

    act(() => {
      result.current.toggleWidget('daily-hours')
    })

    await waitFor(() => {
      expect(result.current.layout.widgets).toHaveLength(7)
    })
    expect(result.current.layout.widgets.find((w) => w.id === 'daily-hours')).toBeUndefined()
  })

  it('toggleWidget adds missing widget', async () => {
    const savedLayout = { widgets: [{ id: 'daily-hours', size: 'medium' }] }
    vi.mocked(window.api.settings.get).mockResolvedValue({
      success: true,
      data: JSON.stringify(savedLayout)
    } as any)

    const { result } = renderHook(() => useDashboardLayout(), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.layout.widgets).toHaveLength(1)
    })

    act(() => {
      result.current.toggleWidget('token-usage')
    })

    await waitFor(() => {
      expect(result.current.layout.widgets).toHaveLength(2)
    })
    expect(result.current.layout.widgets[1].id).toBe('token-usage')
  })

  it('reorderWidgets moves items correctly', async () => {
    const savedLayout = {
      widgets: [
        { id: 'daily-hours', size: 'medium' },
        { id: 'token-usage', size: 'medium' },
        { id: 'peak-hours', size: 'medium' }
      ]
    }
    vi.mocked(window.api.settings.get).mockResolvedValue({
      success: true,
      data: JSON.stringify(savedLayout)
    } as any)

    const { result } = renderHook(() => useDashboardLayout(), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.layout.widgets).toHaveLength(3)
    })

    act(() => {
      result.current.reorderWidgets(0, 2)
    })

    await waitFor(() => {
      expect(result.current.layout.widgets[0].id).toBe('token-usage')
    })
    expect(result.current.layout.widgets[1].id).toBe('peak-hours')
    expect(result.current.layout.widgets[2].id).toBe('daily-hours')
  })

  it('resizeWidget updates size', async () => {
    const { result } = renderHook(() => useDashboardLayout(), { wrapper: createWrapper() })

    await waitFor(() => {
      expect(result.current.layout.widgets).toHaveLength(8)
    })

    act(() => {
      result.current.resizeWidget('daily-hours', 'large')
    })

    await waitFor(() => {
      expect(result.current.layout.widgets.find((w) => w.id === 'daily-hours')?.size).toBe('large')
    })
  })
})
