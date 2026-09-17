import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HistoryReviewPanel } from './HistoryReviewPanel'
import type { SessionReconciliationCase } from '../../../../shared/types/session'

const review: SessionReconciliationCase = {
  fingerprint: 'fixture-fingerprint',
  sourceFile: 'C:\\private\\work.jsonl',
  message: 'Saved totals exceed retained activity in C:\\private\\work.jsonl',
  idleTimeoutMinutes: 5,
  createdAt: '2026-03-04T12:00:00Z',
  updatedAt: '2026-03-04T12:00:00Z',
  saved: [
    {
      id: 1,
      disposition: 'active',
      projectPath: 'C:\\private',
      clientId: 1,
      projectId: 2,
      startedAt: '2026-03-04T10:00:00Z',
      endedAt: '2026-03-04T10:10:00Z',
      durationMinutes: 10,
      promptCount: 2,
      inputTokens: 1000,
      outputTokens: 50,
      modelUsage: []
    }
  ],
  detected: [
    {
      disposition: 'detected',
      projectPath: 'C:\\private',
      clientId: null,
      projectId: null,
      startedAt: '2026-03-04T10:00:00Z',
      endedAt: '2026-03-04T10:05:00Z',
      durationMinutes: 5,
      promptCount: 1,
      inputTokens: 100,
      outputTokens: 50,
      modelUsage: [
        {
          model: 'fixture-model',
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 25,
          cacheReadInputTokens: 75
        }
      ]
    }
  ]
}
const getReviews = vi.fn()
const recheck = vi.fn()
const keep = vi.fn()
const mapHistory = vi.fn()
const replaceHistory = vi.fn()
let presentationMode = false

beforeEach(() => {
  vi.resetAllMocks()
  presentationMode = false
  localStorage.clear()
  getReviews.mockResolvedValue({ success: true, data: [review] })
  vi.stubGlobal('api', {
    sessions: {
      getReconciliationCases: getReviews,
      recheckReconciliation: recheck,
      keepSavedHistory: keep,
      mapSavedHistory: mapHistory,
      replaceSavedHistory: replaceHistory
    },
    settings: {
      getAll: vi.fn().mockImplementation(async () => ({
        success: true,
        data: { presentation_mode: String(presentationMode) }
      }))
    }
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <HistoryReviewPanel />
    </QueryClientProvider>
  )
  return client
}

it('loads a persisted review without a scan and displays saved and detected totals separately', async () => {
  mount()
  fireEvent.click(await screen.findByText(review.sourceFile))
  expect(screen.getByText('Saved history at last check')).toBeInTheDocument()
  expect(screen.getByText(/1000 input \/ 50 output tokens/)).toBeInTheDocument()
  expect(screen.getByText(/100 input \/ 50 output tokens/)).toBeInTheDocument()
  expect(screen.getByText(/fixture-model: 100 input/)).toBeInTheDocument()
  expect(screen.getByText(/Detected alternatives are held outside totals/)).toBeInTheDocument()
  expect(recheck).not.toHaveBeenCalled()
})

it('keeps an unresolved comparison visible after recheck and reports the result', async () => {
  recheck.mockResolvedValue({
    success: true,
    data: { errors: [{ sourceFile: review.sourceFile, message: 'Still ambiguous' }] }
  })
  mount()
  fireEvent.click(await screen.findByText(review.sourceFile))
  fireEvent.click(screen.getByRole('button', { name: 'Recheck retained activity' }))
  expect(await screen.findByRole('status')).toHaveTextContent('Recheck still needs review')
  expect(recheck).toHaveBeenCalledWith(review.sourceFile)
  expect(screen.getByText(review.sourceFile)).toBeInTheDocument()
  await waitFor(() => expect(getReviews).toHaveBeenCalledTimes(2))
})

it('removes a resolved review only after refreshed backend data and invalidates session totals', async () => {
  recheck.mockImplementation(async () => {
    getReviews.mockResolvedValue({ success: true, data: [] })
    return { success: true, data: { newSessions: 1 } }
  })
  const client = mount()
  client.setQueryData(['sessions', 'list'], [])
  fireEvent.click(await screen.findByText(review.sourceFile))
  fireEvent.click(screen.getByRole('button', { name: 'Recheck retained activity' }))
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'History reviews' })).not.toBeInTheDocument()
  )
  expect(client.getQueryState(['sessions', 'list'])?.isInvalidated).toBe(true)
})

it('keeps the review and surfaces a busy-scan rejection', async () => {
  recheck.mockResolvedValue({
    success: false,
    error: { message: 'A scan is running. Recheck after it finishes.' }
  })
  mount()
  fireEvent.click(await screen.findByText(review.sourceFile))
  fireEvent.click(screen.getByRole('button', { name: 'Recheck retained activity' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('A scan is running')
  expect(screen.getByText(review.sourceFile)).toBeInTheDocument()
})

it('shows a load failure with a working retry', async () => {
  getReviews.mockResolvedValueOnce({ success: false, error: { message: 'Fixture read failure' } })
  mount()
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load history reviews')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText(review.sourceFile)).toBeInTheDocument()
})

it('masks source paths and path-bearing reasons in presentation mode', async () => {
  presentationMode = true
  localStorage.setItem('presentation-mode', 'true')
  mount()
  fireEvent.click(await screen.findByText('Source 1'))
  expect(document.body.textContent).not.toContain('private')
  expect(screen.getByText(/could not be matched/)).toBeInTheDocument()
})

it('requires confirmation, permits cancellation and sends the reviewed fingerprint', async () => {
  keep.mockImplementation(async () => {
    getReviews.mockResolvedValue({ success: true, data: [] })
    return { success: true }
  })
  mount()
  fireEvent.click(await screen.findByText(review.sourceFile))
  fireEvent.click(screen.getByRole('button', { name: 'Keep saved history' }))
  expect(screen.getByText(/decision covers this comparison only/)).toBeInTheDocument()
  expect(keep).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(
    screen.queryByRole('button', { name: 'Confirm keep saved history' })
  ).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Keep saved history' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm keep saved history' }))
  await waitFor(() => expect(keep).toHaveBeenCalledWith(review.sourceFile, review.fingerprint))
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'History reviews' })).not.toBeInTheDocument()
  )
})

it('leaves a stale approval visible with a recheck instruction', async () => {
  keep.mockResolvedValue({
    success: false,
    error: { message: 'This comparison changed. Recheck retained activity.' }
  })
  mount()
  fireEvent.click(await screen.findByText(review.sourceFile))
  fireEvent.click(screen.getByRole('button', { name: 'Keep saved history' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm keep saved history' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('comparison changed')
  expect(screen.getByText(review.sourceFile)).toBeInTheDocument()
})

it('does not silently approve a refreshed comparison during confirmation', async () => {
  const client = mount()
  fireEvent.click(await screen.findByText(review.sourceFile))
  fireEvent.click(screen.getByRole('button', { name: 'Keep saved history' }))
  client.setQueryData(
    ['sessions', 'reconciliation'],
    [{ ...review, fingerprint: 'new-fingerprint' }]
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm keep saved history' })).toBeDisabled()
  )
  expect(keep).not.toHaveBeenCalled()
})

it('requires a recheck before approving an older migrated comparison', async () => {
  getReviews.mockResolvedValue({ success: true, data: [{ ...review, fingerprint: null }] })
  mount()
  fireEvent.click(await screen.findByText(review.sourceFile))
  expect(screen.getByRole('button', { name: 'Keep saved history' })).toBeDisabled()
  expect(screen.getByText(/Recheck this older comparison/)).toBeInTheDocument()
})

it('explains source-less adoption before an explicit mapping confirmation', async () => {
  getReviews.mockResolvedValue({
    success: true,
    data: [{ ...review, saved: [{ ...review.saved[0], sourceFile: null }] }]
  })
  mapHistory.mockResolvedValue({ success: true })
  mount()
  fireEvent.click(await screen.findByText(review.sourceFile))
  expect(screen.getByText('Source log not linked')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Map detected activity' }))
  expect(screen.getByText(/will be linked to this log when you confirm/)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Saved session for detected interval 1'), {
    target: { value: '1' }
  })
  expect(mapHistory).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm activity mapping' }))
  await waitFor(() =>
    expect(mapHistory).toHaveBeenCalledWith(review.sourceFile, review.fingerprint, [
      { sessionId: 1, detectedIndex: 0 }
    ])
  )
})

it('requires explicit pairings and confirmation, then refreshes history after mapping', async () => {
  mapHistory.mockImplementation(async () => {
    getReviews.mockResolvedValue({ success: true, data: [] })
    return { success: true }
  })
  const client = mount()
  client.setQueryData(['sessions', 'list'], [])
  client.setQueryData(['git', 'commits', 'session', 1], [])
  client.setQueryData(['ai', 'summary', 1], { summary: '', tier: 'none' })
  fireEvent.click(await screen.findByText(review.sourceFile))
  fireEvent.click(screen.getByRole('button', { name: 'Map detected activity' }))
  expect(screen.getByRole('button', { name: 'Confirm activity mapping' })).toBeDisabled()
  expect(screen.getByText(/Prompt and token totals, including cache usage/)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Saved session for detected interval 1'), {
    target: { value: '1' }
  })
  expect(mapHistory).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm activity mapping' }))
  await waitFor(() =>
    expect(mapHistory).toHaveBeenCalledWith(review.sourceFile, review.fingerprint, [
      { sessionId: 1, detectedIndex: 0 }
    ])
  )
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'History reviews' })).not.toBeInTheDocument()
  )
  expect(client.getQueryState(['sessions', 'list'])?.isInvalidated).toBe(true)
  expect(client.getQueryState(['git', 'commits', 'session', 1])?.isInvalidated).toBe(true)
  expect(client.getQueryState(['ai', 'summary', 1])?.isInvalidated).toBe(true)
})

it('cancels a mapping without applying it and resets selections when the comparison changes', async () => {
  const client = mount()
  fireEvent.click(await screen.findByText(review.sourceFile))
  fireEvent.click(screen.getByRole('button', { name: 'Map detected activity' }))
  fireEvent.change(screen.getByLabelText('Saved session for detected interval 1'), {
    target: { value: '1' }
  })
  client.setQueryData(['sessions', 'reconciliation'], [{ ...review, fingerprint: 'changed' }])
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm activity mapping' })).toBeDisabled()
  )
  expect(screen.getByLabelText('Saved session for detected interval 1')).toHaveValue('')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(mapHistory).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Recheck retained activity' })).toBeEnabled()
})

it('does not offer mappings for split, deleted or differently sized histories', async () => {
  getReviews.mockResolvedValue({
    success: true,
    data: [
      { ...review, sourceFile: 'deleted', saved: [{ ...review.saved[0], disposition: 'deleted' }] },
      { ...review, sourceFile: 'split', saved: [{ ...review.saved[0], disposition: 'split' }] },
      { ...review, sourceFile: 'different-count', detected: [] }
    ]
  })
  mount()
  await screen.findByText('deleted')
  expect(screen.queryByRole('button', { name: 'Map detected activity' })).not.toBeInTheDocument()
})

it('keeps a rejected mapping visible and masks backend paths in presentation mode', async () => {
  presentationMode = true
  localStorage.setItem('presentation-mode', 'true')
  mapHistory.mockResolvedValue({ success: false, error: { message: 'Failed C:\\private\\source' } })
  mount()
  fireEvent.click(await screen.findByText('Source 1'))
  fireEvent.click(screen.getByRole('button', { name: 'Map detected activity' }))
  fireEvent.change(screen.getByLabelText('Saved session for detected interval 1'), {
    target: { value: '1' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm activity mapping' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not apply the mapping')
  expect(document.body.textContent).not.toContain('private')
})

it('requires confirmation for detected intervals, supports cancellation and refreshes after replacement', async () => {
  replaceHistory.mockImplementation(async () => {
    getReviews.mockResolvedValue({ success: true, data: [] })
    return { success: true }
  })
  const client = mount()
  client.setQueryData(['sessions', 'list'], [])
  client.setQueryData(['git', 'commits', 'session', 1], [])
  client.setQueryData(['ai', 'summary', 1], { summary: '', tier: 'none' })
  fireEvent.click(await screen.findByText(review.sourceFile))
  fireEvent.click(screen.getByRole('button', { name: 'Use detected intervals' }))
  expect(replaceHistory).not.toHaveBeenCalled()
  expect(screen.getByText(/billed-work exclusions are preserved/)).toBeInTheDocument()
  expect(
    screen.getByText(/Saved time edits are preserved for unambiguous one-to-one matches/)
  ).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Keep saved history' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(replaceHistory).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Use detected intervals' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm detected intervals' }))
  await waitFor(() =>
    expect(replaceHistory).toHaveBeenCalledWith(review.sourceFile, review.fingerprint, [])
  )
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'History reviews' })).not.toBeInTheDocument()
  )
  expect(client.getQueryState(['sessions', 'list'])?.isInvalidated).toBe(true)
  expect(client.getQueryState(['git', 'commits', 'session', 1])?.isInvalidated).toBe(true)
  expect(client.getQueryState(['ai', 'summary', 1])?.isInvalidated).toBe(true)
})

it.each([false, true])(
  'requires an explicit conflicting value choice with presentation mode %s',
  async (masked) => {
    presentationMode = masked
    localStorage.setItem('presentation-mode', String(masked))
    const conflict = {
      ...review,
      saved: [
        {
          ...review.saved[0],
          description: 'Private first description',
          billable: true,
          status: 'completed'
        },
        {
          ...review.saved[0],
          id: 2,
          description: 'Private second description',
          billable: false,
          status: 'completed'
        },
        { ...review.saved[0], id: 3, description: 'Unrelated session' }
      ],
      detected: [
        { ...review.detected[0], replacementCandidates: [1, 2], requiresReplacementChoice: true }
      ]
    }
    getReviews.mockResolvedValue({ success: true, data: [conflict] })
    replaceHistory.mockResolvedValue({ success: false, error: { message: 'Fixture rejection' } })
    const client = mount()
    fireEvent.click(await screen.findByText(masked ? 'Source 1' : review.sourceFile))
    fireEvent.click(screen.getByRole('button', { name: 'Use detected intervals' }))
    expect(screen.getByRole('button', { name: 'Confirm detected intervals' })).toBeDisabled()
    expect(screen.queryByRole('option', { name: 'Session #3' })).not.toBeInTheDocument()
    expect(document.body.textContent?.includes('Private first description')).toBe(!masked)
    fireEvent.change(screen.getByLabelText('Values for detected interval 1'), {
      target: { value: '2' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm detected intervals' }))
    await waitFor(() =>
      expect(replaceHistory).toHaveBeenCalledWith(review.sourceFile, review.fingerprint, [
        { detectedIndex: 0, sessionId: 2 }
      ])
    )
    await screen.findByRole('alert')
    client.setQueryData(['sessions', 'reconciliation'], [{ ...conflict, fingerprint: 'changed' }])
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Confirm detected intervals' })).toBeDisabled()
    )
    expect(screen.getByLabelText('Values for detected interval 1')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use detected intervals' }))
    expect(screen.getByLabelText('Values for detected interval 1')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Confirm detected intervals' })).toBeDisabled()
  }
)

it('blocks replacement confirmation when the comparison refreshes', async () => {
  const client = mount()
  fireEvent.click(await screen.findByText(review.sourceFile))
  fireEvent.click(screen.getByRole('button', { name: 'Use detected intervals' }))
  client.setQueryData(['sessions', 'reconciliation'], [{ ...review, fingerprint: 'changed' }])
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm detected intervals' })).toBeDisabled()
  )
  expect(replaceHistory).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.getByRole('button', { name: 'Recheck retained activity' })).toBeEnabled()
})

it('keeps rejected replacements visible and masks errors in presentation mode', async () => {
  presentationMode = true
  localStorage.setItem('presentation-mode', 'true')
  replaceHistory.mockResolvedValue({
    success: false,
    error: { message: 'Conflict C:\\private\\source' }
  })
  mount()
  fireEvent.click(await screen.findByText('Source 1'))
  fireEvent.click(screen.getByRole('button', { name: 'Use detected intervals' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm detected intervals' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not replace history')
  expect(document.body.textContent).not.toContain('private')
})

it('shows replaced predecessors as audit history while mapping only active sessions', async () => {
  getReviews.mockResolvedValue({
    success: true,
    data: [
      {
        ...review,
        saved: [{ ...review.saved[0], id: 2, disposition: 'replaced' }, review.saved[0]]
      }
    ]
  })
  mount()
  fireEvent.click(await screen.findByText(review.sourceFile))
  expect(screen.getByText(/Replaced predecessor/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Map detected activity' }))
  expect(screen.getAllByRole('option')).toHaveLength(2)
  expect(screen.getByRole('option', { name: /Session #1/ })).toBeInTheDocument()
})
