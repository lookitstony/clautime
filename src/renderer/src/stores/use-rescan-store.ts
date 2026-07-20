import { create } from 'zustand'

/**
 * Tracks whether the derived session/commit data is stale relative to the saved
 * detection settings. Settings (idle timeout, provider toggles, directories, git
 * identity) persist immediately — nothing is lost — but re-deriving sessions to
 * match them is a separate "rescan" step. Any such change flips `pending` on; a
 * successful rescan clears it. In-memory only: a rescan on the next change (or on
 * leaving the tab) is all we need within a session.
 *
 * `changeToken` guards against a race: a rescan reads the settings at its start,
 * so a change made WHILE it runs isn't reflected. `beginRescan()` snapshots the
 * token; `completeRescan(token)` only clears `pending` if no change landed in
 * between, so a mid-rescan edit correctly leaves the bar showing "rescan to
 * apply" instead of a false "up to date".
 */
interface RescanState {
  /** True when saved settings have not yet been applied via a rescan. */
  pending: boolean
  /** Bumped on every setting change; lets a rescan detect concurrent edits. */
  changeToken: number
  markPending: () => void
  /** Snapshot the current token to pass to completeRescan later. */
  beginRescan: () => number
  /** Clear pending only if no change landed since `token` was taken. */
  completeRescan: (token: number) => void
  /** Force-clear (e.g. after a factory reset re-imports everything). */
  clear: () => void
}

export const useRescanStore = create<RescanState>((set, get) => ({
  pending: false,
  changeToken: 0,
  markPending: () => set((s) => ({ pending: true, changeToken: s.changeToken + 1 })),
  beginRescan: () => get().changeToken,
  completeRescan: (token) => {
    if (get().changeToken === token) set({ pending: false })
  },
  clear: () => set({ pending: false })
}))
