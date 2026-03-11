import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Project, NewProject, UpdateProject } from '../../../../shared/types/client-project'

async function fetchProjects(clientId?: number): Promise<Project[]> {
  const result = await window.api.projects.getAll(clientId)
  if (!result.success) throw new Error(result.error.message)
  return result.data
}

export function useProjects(clientId?: number) {
  return useQuery({
    queryKey: ['projects', clientId],
    queryFn: () => fetchProjects(clientId)
  })
}

export function useCreateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: NewProject) => {
      const result = await window.api.projects.create(data)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      queryClient.invalidateQueries({ queryKey: ['live'] })
      queryClient.invalidateQueries({ queryKey: ['clients'] })
    }
  })
}

export function useUpdateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: UpdateProject }) => {
      const result = await window.api.projects.update(id, data)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      queryClient.invalidateQueries({ queryKey: ['live'] })
    }
  })
}

export function useDeleteProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      const result = await window.api.projects.delete(id)
      if (!result.success) throw new Error(result.error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    }
  })
}

export function useAttributeSessions() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const result = await window.api.projects.attributeSessions()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    }
  })
}
