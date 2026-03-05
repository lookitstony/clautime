import { describe, it, expect, beforeEach } from 'vitest'
import { useFilterStore } from './use-filter-store'

beforeEach(() => {
  useFilterStore.getState().clearFilters()
})

describe('useFilterStore', () => {
  it('starts with all filters null', () => {
    const state = useFilterStore.getState()
    expect(state.datePreset).toBeNull()
    expect(state.startDate).toBeNull()
    expect(state.endDate).toBeNull()
    expect(state.clientId).toBeNull()
    expect(state.projectId).toBeNull()
  })

  it('setDatePreset sets preset and clears custom range', () => {
    const store = useFilterStore.getState()
    store.setCustomRange('2026-03-01T00:00:00Z', '2026-03-05T23:59:59Z')
    store.setDatePreset('today')
    const state = useFilterStore.getState()
    expect(state.datePreset).toBe('today')
    expect(state.startDate).toBeNull()
    expect(state.endDate).toBeNull()
  })

  it('setCustomRange sets dates and clears preset', () => {
    const store = useFilterStore.getState()
    store.setDatePreset('this-week')
    store.setCustomRange('2026-03-01T00:00:00Z', '2026-03-05T23:59:59Z')
    const state = useFilterStore.getState()
    expect(state.datePreset).toBeNull()
    expect(state.startDate).toBe('2026-03-01T00:00:00Z')
    expect(state.endDate).toBe('2026-03-05T23:59:59Z')
  })

  it('setClientId sets client and clears project', () => {
    const store = useFilterStore.getState()
    store.setProjectId(5)
    store.setClientId(1)
    const state = useFilterStore.getState()
    expect(state.clientId).toBe(1)
    expect(state.projectId).toBeNull()
  })

  it('setProjectId sets project without clearing client', () => {
    const store = useFilterStore.getState()
    store.setClientId(1)
    store.setProjectId(5)
    const state = useFilterStore.getState()
    expect(state.clientId).toBe(1)
    expect(state.projectId).toBe(5)
  })

  it('clearFilters resets everything', () => {
    const store = useFilterStore.getState()
    store.setDatePreset('today')
    store.setClientId(1)
    store.clearFilters()
    const state = useFilterStore.getState()
    expect(state.datePreset).toBeNull()
    expect(state.startDate).toBeNull()
    expect(state.endDate).toBeNull()
    expect(state.clientId).toBeNull()
    expect(state.projectId).toBeNull()
  })

  it('hasActiveFilters returns false when empty', () => {
    expect(useFilterStore.getState().hasActiveFilters()).toBe(false)
  })

  it('hasActiveFilters returns true with date preset', () => {
    useFilterStore.getState().setDatePreset('today')
    expect(useFilterStore.getState().hasActiveFilters()).toBe(true)
  })

  it('hasActiveFilters returns true with clientId', () => {
    useFilterStore.getState().setClientId(1)
    expect(useFilterStore.getState().hasActiveFilters()).toBe(true)
  })

  it('toSessionFilters returns empty object when no filters', () => {
    const filters = useFilterStore.getState().toSessionFilters()
    expect(filters).toEqual({})
  })

  it('toSessionFilters computes date range from preset', () => {
    useFilterStore.getState().setDatePreset('today')
    const filters = useFilterStore.getState().toSessionFilters()
    expect(filters.startDate).toBeDefined()
    expect(filters.endDate).toBeDefined()
    // startDate should be start of today
    const start = new Date(filters.startDate!)
    const now = new Date()
    expect(start.getFullYear()).toBe(now.getFullYear())
    expect(start.getMonth()).toBe(now.getMonth())
    expect(start.getDate()).toBe(now.getDate())
    expect(start.getHours()).toBe(0)
  })

  it('toSessionFilters uses custom range when no preset', () => {
    useFilterStore.getState().setCustomRange('2026-03-01T00:00:00Z', '2026-03-05T23:59:59Z')
    const filters = useFilterStore.getState().toSessionFilters()
    expect(filters.startDate).toBe('2026-03-01T00:00:00Z')
    expect(filters.endDate).toBe('2026-03-05T23:59:59Z')
  })

  it('toSessionFilters includes clientId and projectId', () => {
    useFilterStore.getState().setClientId(2)
    useFilterStore.getState().setProjectId(7)
    const filters = useFilterStore.getState().toSessionFilters()
    expect(filters.clientId).toBe(2)
    expect(filters.projectId).toBe(7)
  })
})
