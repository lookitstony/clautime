import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'

const CACHE_KEY = 'presentation-mode'

/**
 * Reads the global `presentation_mode` setting. When true, projects display
 * their stage names (for streaming/demos) instead of their real names.
 * Shares the ['settings','all'] query cache used across the app, so toggling
 * the setting updates every consumer reactively.
 *
 * The last known value is mirrored to localStorage and used while the settings
 * query is still in flight — without it, a cold start renders one frame of real
 * names and unmasked IDs before the setting arrives.
 */
export function usePresentationMode(): boolean {
  const { data } = useQuery({
    queryKey: ['settings', 'all'],
    queryFn: async () => {
      const r = await window.api.settings.getAll()
      return r.success ? r.data : {}
    }
  })

  const setting = data?.['presentation_mode']

  useEffect(() => {
    if (setting !== undefined) {
      localStorage.setItem(CACHE_KEY, setting === 'true' ? 'true' : 'false')
    }
  }, [setting])

  if (setting === undefined) return localStorage.getItem(CACHE_KEY) === 'true'
  return setting === 'true'
}
