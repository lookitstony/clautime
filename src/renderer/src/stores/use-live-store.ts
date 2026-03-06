import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ManualTimerState } from '../../../shared/types/live'

interface LiveStoreState {
  activeTimer: ManualTimerState | null
  startTimer: (
    projectId: number,
    projectName: string,
    projectPath: string,
    clientId: number | null,
    clientName: string | null,
    description?: string | null
  ) => void
  stopTimer: () => ManualTimerState | null
  pauseTimer: () => void
  resumeTimer: () => void
  updateDescription: (desc: string) => void
  discardTimer: () => void
  isStale: () => boolean
  getElapsedMs: () => number
}

function notifyTimerStarted(projectName: string, startedAt: string): void {
  window.api.live.timerStarted(projectName, startedAt).catch(() => {})
}

function notifyTimerStopped(): void {
  window.api.live.timerStopped().catch(() => {})
}

export const useLiveStore = create<LiveStoreState>()(
  persist(
    (set, get) => ({
      activeTimer: null,

      startTimer: (projectId, projectName, projectPath, clientId, clientName, description) => {
        if (get().activeTimer) {
          throw new Error('A timer is already running')
        }
        const startedAt = new Date().toISOString()
        set({
          activeTimer: {
            projectId,
            projectName,
            projectPath,
            clientId,
            clientName,
            startedAt,
            description: description ?? null,
            pausedAt: null,
            totalPausedMs: 0
          }
        })
        notifyTimerStarted(projectName, startedAt)
      },

      stopTimer: () => {
        const timer = get().activeTimer
        set({ activeTimer: null })
        notifyTimerStopped()
        return timer
      },

      pauseTimer: () => {
        const timer = get().activeTimer
        if (timer && !timer.pausedAt) {
          set({ activeTimer: { ...timer, pausedAt: new Date().toISOString() } })
        }
      },

      resumeTimer: () => {
        const timer = get().activeTimer
        if (timer && timer.pausedAt) {
          const pausedMs = Date.now() - Date.parse(timer.pausedAt)
          set({
            activeTimer: {
              ...timer,
              pausedAt: null,
              totalPausedMs: timer.totalPausedMs + pausedMs
            }
          })
        }
      },

      updateDescription: (desc) => {
        const timer = get().activeTimer
        if (timer) {
          set({ activeTimer: { ...timer, description: desc } })
        }
      },

      discardTimer: () => {
        set({ activeTimer: null })
        notifyTimerStopped()
      },

      isStale: () => {
        const timer = get().activeTimer
        if (!timer) return false
        const elapsed = Date.now() - Date.parse(timer.startedAt)
        return elapsed > 24 * 60 * 60 * 1000
      },

      getElapsedMs: () => {
        const timer = get().activeTimer
        if (!timer) return 0
        const now = timer.pausedAt ? Date.parse(timer.pausedAt) : Date.now()
        return now - Date.parse(timer.startedAt) - timer.totalPausedMs
      }
    }),
    {
      name: 'live-timer-store',
      partialize: (state) => ({ activeTimer: state.activeTimer }),
      onRehydrateStorage: () => (state) => {
        if (state?.activeTimer) {
          notifyTimerStarted(state.activeTimer.projectName, state.activeTimer.startedAt)
        }
      }
    }
  )
)

// Sync timer state across windows via localStorage storage event
// This only fires in OTHER windows when localStorage changes — no loop risk
window.addEventListener('storage', (e) => {
  if (e.key === 'live-timer-store' && e.newValue) {
    try {
      const parsed = JSON.parse(e.newValue)
      const synced = parsed?.state?.activeTimer ?? null
      useLiveStore.setState({ activeTimer: synced })
    } catch {
      // Ignore malformed data
    }
  }
})
