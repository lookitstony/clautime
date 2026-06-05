import { useQuery } from '@tanstack/react-query'

export function useStripeMode() {
  const { data: mode = 'live' } = useQuery({
    queryKey: ['stripe', 'mode'],
    queryFn: async () => {
      const r = await window.api.invoice.getStripeMode()
      return r.success ? r.data : ('live' as const)
    }
  })
  return { mode, isTestMode: mode === 'test' }
}
