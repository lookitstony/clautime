import { describe, it, expect, beforeEach } from 'vitest'
import { useUIStore } from './use-ui-store'

describe('useUIStore', () => {
  beforeEach(() => {
    useUIStore.setState({ activeView: '/', lastActiveView: '/' })
  })

  it('has correct initial state', () => {
    const state = useUIStore.getState()
    expect(state.activeView).toBe('/')
    expect(state.lastActiveView).toBe('/')
  })

  it('updates activeView and lastActiveView on setActiveView', () => {
    useUIStore.getState().setActiveView('/sessions')
    const state = useUIStore.getState()
    expect(state.activeView).toBe('/sessions')
    expect(state.lastActiveView).toBe('/sessions')
  })

  it('tracks view changes sequentially', () => {
    useUIStore.getState().setActiveView('/sessions')
    useUIStore.getState().setActiveView('/reports')
    const state = useUIStore.getState()
    expect(state.activeView).toBe('/reports')
    expect(state.lastActiveView).toBe('/reports')
  })
})
