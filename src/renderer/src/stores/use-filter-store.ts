import { create } from 'zustand'
import { getDateRangeForPreset, type DatePreset } from '@/lib/format'
import type { SessionFilters, SessionTool } from '../../../shared/types/session'

interface FilterState {
  datePreset: DatePreset | null
  startDate: string | null
  endDate: string | null
  clientId: number | null
  projectId: number | null
  tool: SessionTool | null
  /** Device UUID. Sessions view only; invoice generation keeps its own client/date scope. */
  sourceMachine: string | null
  weekStartDay: number
  setDatePreset: (preset: DatePreset | null) => void
  setCustomRange: (startDate: string, endDate: string) => void
  setClientId: (clientId: number | null) => void
  setProjectId: (projectId: number | null) => void
  setTool: (tool: SessionTool | null) => void
  setSourceMachine: (deviceId: string | null) => void
  setWeekStartDay: (day: number) => void
  clearFilters: () => void
  toSessionFilters: (timeZone?: string) => SessionFilters
  hasActiveFilters: () => boolean
}

export const useFilterStore = create<FilterState>()((set, get) => ({
  datePreset: null,
  startDate: null,
  endDate: null,
  clientId: null,
  projectId: null,
  tool: null,
  sourceMachine: null,
  weekStartDay: 1,

  setDatePreset: (preset) => set({ datePreset: preset, startDate: null, endDate: null }),

  setCustomRange: (startDate, endDate) => set({ datePreset: null, startDate, endDate }),

  setClientId: (clientId) => set({ clientId, projectId: null }),

  setProjectId: (projectId) => set({ projectId }),

  setTool: (tool) => set({ tool }),

  setSourceMachine: (sourceMachine) => set({ sourceMachine }),

  setWeekStartDay: (day) => set({ weekStartDay: day }),

  clearFilters: () =>
    set({
      datePreset: null,
      startDate: null,
      endDate: null,
      clientId: null,
      projectId: null,
      tool: null,
      sourceMachine: null
    }),

  toSessionFilters: (timeZone?: string): SessionFilters => {
    const {
      datePreset,
      startDate,
      endDate,
      clientId,
      projectId,
      tool,
      sourceMachine,
      weekStartDay
    } = get()
    const range = datePreset
      ? getDateRangeForPreset(datePreset, weekStartDay, timeZone)
      : { startDate, endDate }
    const filters: SessionFilters = {}
    if (range.startDate) filters.startDate = range.startDate
    if (range.endDate) filters.endDate = range.endDate
    if (clientId != null) filters.clientId = clientId
    if (projectId != null) filters.projectId = projectId
    if (tool != null) filters.tool = tool
    if (sourceMachine != null) filters.sourceMachine = sourceMachine
    return filters
  },

  hasActiveFilters: (): boolean => {
    const { datePreset, startDate, endDate, clientId, projectId, tool, sourceMachine } = get()
    return (
      datePreset != null ||
      startDate != null ||
      endDate != null ||
      clientId != null ||
      projectId != null ||
      tool != null ||
      sourceMachine != null
    )
  }
}))
