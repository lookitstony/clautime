import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SyncConflictReview } from './SyncConflictReview'
import type {
  LegacyConflict,
  LegacyEditConflict,
  RecordConflict,
  SyncConflictReview as Review
} from '../../../../shared/types/sync-conflict'

let cache: QueryClient
const success = <T,>(data: T) => ({ success: true as const, data })
const heads = {
  $present: ['11111111-1111-4111-8111-111111111111'],
  name: ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
}
const conflict: RecordConflict = {
  kind: 'record',
  key: 'client:c1',
  entityType: 'client',
  entityId: '44444444-4444-4444-8444-444444444444',
  title: 'Client Acme',
  lifecycleConflict: false,
  expectedHeads: heads,
  fields: [
    {
      field: 'name',
      label: 'Name',
      lastAgreed: { value: 'Acme', label: 'Acme' },
      alternatives: [
        { value: 'Acme North', label: 'Acme North' },
        { value: 'Acme South', label: 'Acme South' }
      ]
    }
  ]
}
const review: Review = {
  items: [
    conflict,
    {
      kind: 'held',
      key: 'invoice:1',
      title: 'Invoice',
      explanation: 'Use its refresh action on the Invoices page.'
    }
  ]
}

beforeEach(() => {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('api', {
    settings: { getAll: vi.fn().mockResolvedValue(success({})) },
    syncConflicts: {
      list: vi.fn().mockResolvedValue(success(review)),
      resolve: vi.fn().mockResolvedValue(success({ followUp: [] }))
    }
  })
})
afterEach(() => {
  cleanup()
  cache.clear()
  vi.unstubAllGlobals()
})
function show() {
  render(
    <QueryClientProvider client={cache}>
      <SyncConflictReview />
    </QueryClientProvider>
  )
}
const api = () =>
  (
    window.api as unknown as {
      syncConflicts: { list: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> }
    }
  ).syncConflicts

it('cancelling a review never resolves anything', async () => {
  show()
  fireEvent.click((await screen.findAllByRole('button', { name: 'Review' }))[0])
  expect(screen.getByText('Last agreed: Acme')).toBeInTheDocument()
  const save = screen.getByRole('button', { name: 'Save choice' })
  expect(save).toBeDisabled()
  fireEvent.click(screen.getByRole('radio', { name: 'Acme South' }))
  expect(save).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('button', { name: 'Save choice' })).not.toBeInTheDocument()
  expect(api().resolve).not.toHaveBeenCalled()
})

it('resolves with the selected alternative and the exact heads that were shown', async () => {
  show()
  fireEvent.click((await screen.findAllByRole('button', { name: 'Review' }))[0])
  fireEvent.click(screen.getByRole('radio', { name: 'Acme South' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save choice' }))
  await waitFor(() =>
    expect(api().resolve).toHaveBeenCalledWith({
      kind: 'record',
      entityType: 'client',
      entityId: conflict.entityId,
      expectedHeads: heads,
      present: true,
      values: { name: 'Acme South' }
    })
  )
  expect(api().list).toHaveBeenCalledWith({ presentation: false })
})

it('shows a stale review as an error and keeps held items explanatory only', async () => {
  api().resolve.mockResolvedValue({
    success: false,
    error: {
      code: 'SYNC_STALE_REVIEW',
      message: 'This conflict changed since it was shown. Review it again.'
    }
  })
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
  expect(screen.getByText('Use its refresh action on the Invoices page.')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Review' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Acme North' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save choice' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('changed since it was shown')
  // The stale editor closes, so the refreshed item is reviewed from scratch.
  expect(screen.queryByRole('button', { name: 'Save choice' })).not.toBeInTheDocument()
  expect(screen.queryByText(/[A-Z]:\//)).not.toBeInTheDocument()
})

const copyA = '55555555-5555-4555-8555-555555555555'
const copyB = '66666666-6666-4666-8666-666666666666'
const legacy: LegacyConflict = {
  kind: 'legacy',
  key: 'legacy:1',
  provider: 'claude',
  conversationId: 'conversation-x',
  title: 'Saved Claude history',
  explanation: 'Two computers reviewed these copies differently.',
  candidates: [
    { legacyId: copyA, label: 'First copy.', counting: true },
    { legacyId: copyB, label: 'Second copy.', counting: false }
  ],
  previousReviews: [
    { label: 'Keep copy 1; duplicates: copy 2', keep: [copyA], duplicates: [copyB] }
  ],
  activityOverlap: false,
  reviewFingerprint: 'f'.repeat(64)
}

it('starts a duplicate review from an earlier one only when asked, and sends the review it showed', async () => {
  api().list.mockResolvedValue(success({ items: [legacy] }))
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
  expect(screen.getByText(/First copy\. Counts now\./)).toBeInTheDocument()
  expect(screen.getByText(/Second copy\. Not counted now\./)).toBeInTheDocument()
  const save = screen.getByRole('button', { name: 'Save choice' })
  expect(save).toBeDisabled()

  // Marking every copy as a duplicate is refused when no activity covers the time.
  for (const radio of screen.getAllByRole('radio', { name: 'Duplicate' })) fireEvent.click(radio)
  expect(save).toBeDisabled()
  expect(screen.getByText(/Keep at least one copy/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Start from this' }))
  expect(screen.getAllByRole('radio', { name: 'Keep counting' })[0]).toBeChecked()
  expect(screen.getAllByRole('radio', { name: 'Duplicate' })[1]).toBeChecked()
  expect(api().resolve).not.toHaveBeenCalled()
  fireEvent.click(save)
  await waitFor(() =>
    expect(api().resolve).toHaveBeenCalledWith({
      kind: 'legacy',
      provider: 'claude',
      conversationId: 'conversation-x',
      reviewFingerprint: 'f'.repeat(64),
      candidates: [copyA, copyB],
      keep: [copyA],
      duplicates: [copyB]
    })
  )
})

const legacyEdit: LegacyEditConflict = {
  kind: 'legacy-edit',
  key: 'legacy-edit:1',
  legacyId: copyA,
  title: 'Saved Claude session',
  current: 'Until you choose, it keeps its last agreed values and counts in totals.',
  lifecycle: [
    { present: true, disposition: null, label: 'Keep it counting as one saved session' },
    {
      present: false,
      disposition: { kind: 'deleted' },
      label: 'Remove it from totals (it stays saved for audit)'
    }
  ],
  fields: [
    {
      field: 'description',
      label: 'Description',
      lastAgreed: { value: 'Original', label: 'Original' },
      alternatives: [
        { value: 'Laptop', label: 'Laptop' },
        { value: 'Desktop', label: 'Desktop' }
      ]
    }
  ],
  waiting: [],
  expectedHeads: heads
}

it('requires an explicit keep-or-remove choice for a saved session and echoes it exactly', async () => {
  api().list.mockResolvedValue(success({ items: [legacyEdit] }))
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
  expect(screen.getByText(legacyEdit.current)).toBeInTheDocument()
  const save = screen.getByRole('button', { name: 'Save choice' })
  // Choosing a value alone is not enough while keep-or-remove is open.
  fireEvent.click(screen.getByRole('radio', { name: 'Laptop' }))
  expect(save).toBeDisabled()
  fireEvent.click(screen.getByRole('radio', { name: 'Keep it counting as one saved session' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Keep the last agreed value: Original' }))
  expect(save).toBeEnabled()
  fireEvent.click(save)
  await waitFor(() =>
    expect(api().resolve).toHaveBeenCalledWith({
      kind: 'legacy-edit',
      legacyId: copyA,
      expectedHeads: heads,
      lifecycle: { present: true, disposition: null },
      values: { description: 'Original' }
    })
  )
})

it('removing a saved session needs no field choices', async () => {
  api().list.mockResolvedValue(success({ items: [legacyEdit] }))
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
  fireEvent.click(
    screen.getByRole('radio', { name: 'Remove it from totals (it stays saved for audit)' })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save choice' }))
  await waitFor(() =>
    expect(api().resolve).toHaveBeenCalledWith({
      kind: 'legacy-edit',
      legacyId: copyA,
      expectedHeads: heads,
      lifecycle: { present: false, disposition: { kind: 'deleted' } },
      values: {}
    })
  )
})

const split = { kind: 'split', splitAt: '2026-03-05T09:20:00.000Z', children: [copyA, copyB] }
const manual: RecordConflict = {
  kind: 'record',
  key: 'manual-entry:m1',
  entityType: 'manual-entry',
  entityId: '77777777-7777-4777-8777-777777777777',
  title: 'Manual time',
  lifecycleConflict: true,
  fields: [],
  expectedHeads: heads,
  lifecycleChoices: [
    { present: true, disposition: null, label: 'Keep it counting as one entry' },
    {
      present: false,
      disposition: { kind: 'deleted' },
      label: 'Delete it (kept for audit, no longer counted)'
    },
    { present: false, disposition: split, label: 'Split it into 2 parts that count instead' }
  ],
  waiting: ['2 part(s) split from it do not count until you choose.']
}

it('offers keep, delete and the recorded split of a manual entry and echoes the chosen split exactly', async () => {
  api().list.mockResolvedValue(success({ items: [manual] }))
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
  expect(screen.getByText(manual.waiting![0])).toBeInTheDocument()
  // The plain keep/delete pair is replaced by the exact recorded choices.
  expect(screen.queryByRole('radio', { name: 'Keep it' })).not.toBeInTheDocument()
  const save = screen.getByRole('button', { name: 'Save choice' })
  expect(save).toBeDisabled()
  fireEvent.click(screen.getByRole('radio', { name: 'Split it into 2 parts that count instead' }))
  fireEvent.click(save)
  await waitFor(() =>
    expect(api().resolve).toHaveBeenCalledWith({
      kind: 'record',
      entityType: 'manual-entry',
      entityId: manual.entityId,
      expectedHeads: heads,
      present: false,
      values: {},
      disposition: split
    })
  )
})
