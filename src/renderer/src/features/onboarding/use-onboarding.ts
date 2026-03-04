import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { DiscoveredProject } from '../../../../shared/types/session'

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

export function useOpenFolderPicker() {
  return useMutation({
    mutationFn: async (): Promise<string | null> => {
      const result = await window.api.dialog.openFolder()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
}

export function useDiscoverProjects() {
  return useMutation({
    mutationFn: async (folderPath?: string): Promise<DiscoveredProject[]> => {
      const result = await window.api.dialog.discoverProjects(folderPath)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
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
