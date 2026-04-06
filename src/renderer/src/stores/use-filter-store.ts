import { create } from 'zustand'
import { getDateRangeForPreset, type DatePreset } from '@/lib/format'
import type { SessionFilters } from '../../../shared/types/session'

interface FilterState {
  datePreset: DatePreset | null
  startDate: string | null
  endDate: string | null
  clientId: number | null
  projectId: number | null
  weekStartDay: number
  setDatePreset: (preset: DatePreset | null) => void
  setCustomRange: (startDate: string, endDate: string) => void
  setClientId: (clientId: number | null) => void
  setProjectId: (projectId: number | null) => void
  setWeekStartDay: (day: number) => void
  clearFilters: () => void
  toSessionFilters: () => SessionFilters
  hasActiveFilters: () => boolean
}

export const useFilterStore = create<FilterState>()((set, get) => ({
  datePreset: null,
  startDate: null,
  endDate: null,
  clientId: null,
  projectId: null,
  weekStartDay: 1,

  setDatePreset: (preset) =>
    set({ datePreset: preset, startDate: null, endDate: null }),

  setCustomRange: (startDate, endDate) =>
    set({ datePreset: null, startDate, endDate }),

  setClientId: (clientId) =>
    set({ clientId, projectId: null }),

  setProjectId: (projectId) =>
    set({ projectId }),

  setWeekStartDay: (day) =>
    set({ weekStartDay: day }),

  clearFilters: () =>
    set({ datePreset: null, startDate: null, endDate: null, clientId: null, projectId: null }),

  toSessionFilters: (): SessionFilters => {
    const { datePreset, startDate, endDate, clientId, projectId, weekStartDay } = get()
    const range = datePreset ? getDateRangeForPreset(datePreset, weekStartDay) : { startDate, endDate }
    const filters: SessionFilters = {}
    if (range.startDate) filters.startDate = range.startDate
    if (range.endDate) filters.endDate = range.endDate
    if (clientId != null) filters.clientId = clientId
    if (projectId != null) filters.projectId = projectId
    return filters
  },

  hasActiveFilters: (): boolean => {
    const { datePreset, startDate, endDate, clientId, projectId } = get()
    return datePreset != null || startDate != null || endDate != null || clientId != null || projectId != null
  }
}))
