import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  TodayStats,
  ProjectLiveStatus,
  ProjectAlertConfig
} from '../../../../shared/types/live'
import { estimateCostUsd } from '../../../../shared/pricing'

// Cross-window query invalidation
const liveChannel = new BroadcastChannel('clautime-live-queries')

function broadcastInvalidate(): void {
  liveChannel.postMessage({ type: 'invalidate-live' })
}

export function useLiveBroadcastSync(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      if (event.data?.type === 'invalidate-live') {
        queryClient.invalidateQueries({ queryKey: ['live'] })
      }
    }
    liveChannel.addEventListener('message', handler)
    return () => liveChannel.removeEventListener('message', handler)
  }, [queryClient])
}

async function fetchTodayStats(): Promise<TodayStats> {
  const result = await window.api.live.getTodayStats()
  if (!result.success) throw new Error(result.error.message)
  return result.data
}

async function fetchProjectStatuses(): Promise<ProjectLiveStatus[]> {
  const result = await window.api.live.getProjectStatuses()
  if (!result.success) throw new Error(result.error.message)
  return result.data
}

async function fetchAlertConfig(projectId: number): Promise<ProjectAlertConfig> {
  const result = await window.api.live.getAlertConfig(projectId)
  if (!result.success) throw new Error(result.error.message)
  return result.data
}

async function fetchVisibleWidgets(): Promise<number[]> {
  const result = await window.api.live.getVisibleWidgets()
  if (!result.success) throw new Error(result.error.message)
  return result.data
}

async function fetchAvailableSounds(): Promise<{ name: string; filename: string }[]> {
  const result = await window.api.live.getAvailableSounds()
  if (!result.success) throw new Error(result.error.message)
  return result.data
}

/**
 * Project IDs whose floating widget is currently on screen. Main pushes
 * `widget:stateChanged` whenever anything opens/closes/hides, so the icons
 * never fall out of sync with the real windows.
 */
export function useVisibleWidgets() {
  const queryClient = useQueryClient()
  useEffect(() => {
    return window.api.live.onWidgetStateChanged((ids) => {
      queryClient.setQueryData(['live', 'widgets'], ids)
    })
  }, [queryClient])

  return useQuery({
    queryKey: ['live', 'widgets'],
    queryFn: fetchVisibleWidgets,
    refetchInterval: 10000
  })
}

export function useTodayStats() {
  return useQuery({
    queryKey: ['live', 'stats'],
    queryFn: fetchTodayStats,
    refetchInterval: 15000
  })
}

/** Estimated API cost (USD) for today's scanned usage. Null until data exists. */
export function useTodayCost(): string | null {
  const { data } = useQuery({
    queryKey: ['live', 'todayCost'],
    queryFn: async () => {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(end.getDate() + 1)
      const result = await window.api.sessions.getModelUsage({
        startDate: start.toISOString(),
        endDate: end.toISOString()
      })
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    refetchInterval: 15000
  })

  if (!data || data.length === 0) return null
  const total = data.reduce((sum, u) => sum + estimateCostUsd(u.model, u), 0)
  return total.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export function useProjectStatuses() {
  return useQuery({
    queryKey: ['live', 'statuses'],
    queryFn: fetchProjectStatuses,
    refetchInterval: 15000
  })
}

export function useSetWatching() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ projectId, enabled }: { projectId: number; enabled: boolean }) => {
      const result = await window.api.live.setWatching(projectId, enabled)
      if (!result.success) throw new Error(result.error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['live', 'statuses'] })
      broadcastInvalidate()
    }
  })
}

export function useAlertConfig(projectId: number | null) {
  return useQuery({
    queryKey: ['live', 'alertConfig', projectId],
    queryFn: () => fetchAlertConfig(projectId!),
    enabled: projectId != null
  })
}

export function useSetAlertConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ projectId, alertSound }: { projectId: number; alertSound: string }) => {
      const result = await window.api.live.setAlertConfig(projectId, alertSound)
      if (!result.success) throw new Error(result.error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['live', 'alertConfig'] })
      queryClient.invalidateQueries({ queryKey: ['live', 'statuses'] })
      broadcastInvalidate()
    }
  })
}

export function useAvailableSounds() {
  return useQuery({
    queryKey: ['live', 'sounds'],
    queryFn: fetchAvailableSounds,
    staleTime: Infinity
  })
}

export function useSelectCustomSound() {
  return useMutation({
    mutationFn: async () => {
      const result = await window.api.live.selectCustomSound()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
}
