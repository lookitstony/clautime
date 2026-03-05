import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { GitCommit, GitScanResult, GitIdentity } from '../../../../shared/types/git'

export function useGitCommitsForSession(sessionId: number | null) {
  return useQuery({
    queryKey: ['git', 'commits', 'session', sessionId],
    queryFn: async () => {
      const result = await window.api.git.getCommitsForSession(sessionId!)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    enabled: sessionId != null
  })
}

export function useGitCommitsForProject(projectId: number | null) {
  return useQuery({
    queryKey: ['git', 'commits', 'project', projectId],
    queryFn: async () => {
      const result = await window.api.git.getCommitsForProject(projectId!)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    enabled: projectId != null
  })
}

export function useGitIdentity() {
  return useQuery({
    queryKey: ['git', 'identity'],
    queryFn: async () => {
      const result = await window.api.git.getIdentity()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
}

export function useDetectGitIdentity() {
  return useQuery({
    queryKey: ['git', 'identity', 'detected'],
    queryFn: async () => {
      const result = await window.api.git.detectIdentity()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
}

export function useSetGitIdentity() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ name, email }: { name: string; email: string }) => {
      const result = await window.api.git.setIdentity(name, email)
      if (!result.success) throw new Error(result.error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['git', 'identity'] })
      toast.success('Git identity saved')
    }
  })
}

export function useGitScan() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (projectFilter?: number[]) => {
      const result = await window.api.git.scan(projectFilter)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['git'] })
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      const parts = [`${data.newCommits} commits found`]
      if (data.correlated > 0) parts.push(`${data.correlated} correlated`)
      toast.success(`Git scan: ${parts.join(', ')}`)
    }
  })
}
