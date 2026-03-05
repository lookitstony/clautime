import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Client, NewClient, UpdateClient } from '../../../../shared/types/client-project'

async function fetchClients(): Promise<Client[]> {
  const result = await window.api.clients.getAll()
  if (!result.success) throw new Error(result.error.message)
  return result.data
}

export function useClients() {
  return useQuery({
    queryKey: ['clients'],
    queryFn: fetchClients
  })
}

export function useCreateClient() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: NewClient) => {
      const result = await window.api.clients.create(data)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] })
    }
  })
}

export function useUpdateClient() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: UpdateClient }) => {
      const result = await window.api.clients.update(id, data)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] })
    }
  })
}

export function useDeleteClient() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      const result = await window.api.clients.delete(id)
      if (!result.success) throw new Error(result.error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] })
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    }
  })
}
