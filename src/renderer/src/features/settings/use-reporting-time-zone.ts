import { useQuery } from '@tanstack/react-query'

export function useWorkspacePolicy() {
  return useQuery({
    queryKey: ['workspace-policy'],
    queryFn: async () => {
      const result = await window.api.workspace.getPolicy()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
}

export function useReportingTimeZone(): string | undefined {
  return useWorkspacePolicy().data?.policy.reportingTimeZone
}
