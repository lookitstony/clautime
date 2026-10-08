import { beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useRescanStore } from '@/stores/use-rescan-store'
import { reportScanErrors } from './scan-errors'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

beforeEach(() => {
  vi.clearAllMocks()
  useRescanStore.getState().clear()
})

it('keeps partial scans pending and displays the unresolved source', () => {
  const beforeScan = useRescanStore.getState().beginRescan()
  expect(
    reportScanErrors([{ sourceFile: 'legacy.jsonl', message: 'legacy.jsonl needs reconciliation' }])
  ).toBe(true)
  useRescanStore.getState().completeRescan(beforeScan)
  expect(useRescanStore.getState().pending).toBe(true)
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining('Other files were updated'),
    expect.objectContaining({
      description: 'legacy.jsonl needs reconciliation',
      duration: Infinity
    })
  )
})

it('leaves an existing unresolved warning pending when another project scans cleanly', () => {
  useRescanStore.getState().markPending()
  expect(reportScanErrors([])).toBe(false)
  expect(reportScanErrors()).toBe(false)
  expect(useRescanStore.getState().pending).toBe(true)
  expect(toast.error).not.toHaveBeenCalled()
})
