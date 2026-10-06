import { useQuery } from '@tanstack/react-query'
import type { SourceMachineSummary } from '../../../../shared/types/source-machine'

/** Every known source machine (not only those in the current, possibly filtered, list). */
export function useSourceMachines() {
  return useQuery({
    queryKey: ['machines'],
    queryFn: async (): Promise<SourceMachineSummary[]> => {
      const api = window.api.machines
      if (!api) return []
      const result = await api.list()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
}
