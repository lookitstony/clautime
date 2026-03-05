import { useMutation } from '@tanstack/react-query'
import type { ReportFilters, ReportFormat } from '../../../../shared/types/report'

export function useGenerateReport() {
  return useMutation({
    mutationFn: async ({ filters, format }: { filters: ReportFilters; format: ReportFormat }) => {
      const result = await window.api.reports.generate(filters, format)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
}
