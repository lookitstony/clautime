import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export function useIsFirstLaunch() {
  const { data, isLoading } = useQuery({
    queryKey: ['settings', 'setup_complete'],
    queryFn: async () => {
      const result = await window.api.settings.get('setup_complete')
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
  return { isFirstLaunch: !isLoading && data !== 'true', isLoading }
}

export function useCompleteSetup() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<void> => {
      const result = await window.api.settings.set('setup_complete', 'true')
      if (!result.success) throw new Error(result.error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    }
  })
}
