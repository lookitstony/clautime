import { useQuery } from '@tanstack/react-query'

/**
 * Reads the global `presentation_mode` setting. When true, projects display
 * their stage names (for streaming/demos) instead of their real names.
 * Shares the ['settings','all'] query cache used across the app, so toggling
 * the setting updates every consumer reactively.
 */
export function usePresentationMode(): boolean {
  const { data } = useQuery({
    queryKey: ['settings', 'all'],
    queryFn: async () => {
      const r = await window.api.settings.getAll()
      return r.success ? r.data : {}
    }
  })
  return data?.['presentation_mode'] === 'true'
}
