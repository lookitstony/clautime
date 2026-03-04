import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UIState {
  activeView: string
  lastActiveView: string
  setActiveView: (view: string) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      activeView: '/',
      lastActiveView: '/',
      setActiveView: (view) => set({ activeView: view, lastActiveView: view })
    }),
    {
      name: 'ui-store',
      partialize: (state) => ({ lastActiveView: state.lastActiveView })
    }
  )
)
