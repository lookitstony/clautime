import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorkspacePolicySettings } from './WorkspacePolicySettings'
import type {
  WorkspacePolicyReview,
  WorkspacePolicyState
} from '../../../../shared/types/workspace-policy'

const workspace: WorkspacePolicyState = {
  workspaceId: 'workspace',
  revisionId: 'revision',
  policy: {
    version: 1,
    normalizationVersion: 1,
    detectorVersion: 1,
    idleTimeoutMinutes: 15,
    reportingTimeZone: 'UTC'
  }
}
const baseReview: WorkspacePolicyReview = {
  decisionId: 'decision',
  fingerprint: 'receipt',
  candidate: { ...workspace.policy, idleTimeoutMinutes: 5 },
  choices: [],
  heldKeys: [],
  acknowledgedReductions: [],
  reductions: [],
  conversations: [],
  retainedWithoutActivity: []
}
let client: QueryClient
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('api', {
    workspace: {
      reviewPolicy: vi.fn().mockResolvedValue({ success: true, data: baseReview }),
      applyPolicy: vi.fn().mockResolvedValue({ success: true, data: undefined }),
      reviewActivity: vi.fn(),
      adoptActivity: vi.fn()
    }
  })
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.unstubAllGlobals()
})
function mount() {
  render(
    <QueryClientProvider client={client}>
      <WorkspacePolicySettings workspace={workspace} />
    </QueryClientProvider>
  )
}
async function openReview() {
  fireEvent.change(screen.getByLabelText('Shared human time allowance'), { target: { value: '5' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review policy change' }))
  await screen.findByRole('button', { name: 'Apply reviewed policy' })
  await waitFor(() => expect(screen.queryByText('Updating review…')).not.toBeInTheDocument())
}

it('requires held history acknowledgment and sends the exact reviewed decision', async () => {
  const data = { ...baseReview, heldKeys: ['saved:8'], retainedWithoutActivity: [8] }
  vi.mocked(window.api.workspace.reviewPolicy).mockResolvedValue({ success: true, data })
  mount()
  await openReview()
  const apply = screen.getByRole('button', { name: 'Apply reviewed policy' })
  expect(apply).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: /Keep saved session 8 unchanged/ }))
  fireEvent.click(apply)
  await waitFor(() =>
    expect(window.api.workspace.applyPolicy).toHaveBeenCalledWith({
      decisionId: data.decisionId,
      candidate: data.candidate,
      expectedFingerprint: data.fingerprint,
      choices: [],
      acknowledgedHeld: ['saved:8'],
      acknowledgedReductions: []
    })
  )
  expect(
    await screen.findByText('Tracking policy applied. Held history remains unchanged.')
  ).toBeInTheDocument()
})

it('discards stale approval and never reports success when application is rejected', async () => {
  vi.mocked(window.api.workspace.applyPolicy).mockResolvedValue({
    success: false,
    error: { code: 'STALE', message: 'History changed; review again' }
  })
  mount()
  await openReview()
  fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed policy' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('History changed; review again')
  expect(screen.queryByRole('button', { name: 'Apply reviewed policy' })).not.toBeInTheDocument()
  expect(screen.queryByText(/Tracking policy applied/)).not.toBeInTheDocument()
})

it('invalidates a displayed review immediately when its candidate changes', async () => {
  mount()
  await openReview()
  fireEvent.change(screen.getByLabelText('Reporting timezone'), {
    target: { value: 'America/New_York' }
  })
  expect(screen.queryByRole('button', { name: 'Apply reviewed policy' })).not.toBeInTheDocument()
  expect(window.api.workspace.applyPolicy).not.toHaveBeenCalled()
})

it('rechecks counted-time reductions before enabling their application', async () => {
  const reduction = {
    key: 'reduction-key',
    conversationId: 'chat',
    beforeMinutes: 20,
    afterMinutes: 2,
    uncountedEvents: 0,
    uncountedUsage: 0,
    uncountedTokens: 0,
    gaps: [{ startedAt: '2026-09-26T10:00:00Z', endedAt: '2026-09-26T10:20:00Z' }]
  }
  const pending = {
    ...baseReview,
    reductions: [reduction],
    heldKeys: ['["claude","chat"]'],
    conversations: [
      {
        key: '["claude","chat"]',
        provider: 'claude',
        conversationId: 'chat',
        status: 'held' as const,
        reasons: ['lost-continuity-coverage'],
        before: [],
        after: [],
        requiredChoices: []
      }
    ]
  }
  vi.mocked(window.api.workspace.reviewPolicy)
    .mockResolvedValueOnce({ success: true, data: pending })
    .mockResolvedValueOnce({
      success: true,
      data: { ...pending, heldKeys: [], acknowledgedReductions: [reduction.key], conversations: [] }
    })
  mount()
  await openReview()
  expect(screen.getByRole('button', { name: 'Apply reviewed policy' })).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: /Recalculate chat/ }))
  await waitFor(() =>
    expect(window.api.workspace.reviewPolicy).toHaveBeenLastCalledWith({
      candidate: baseReview.candidate,
      decisionId: baseReview.decisionId,
      choices: [],
      acknowledgedReductions: [reduction.key]
    })
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Apply reviewed policy' })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed policy' }))
  await waitFor(() =>
    expect(window.api.workspace.applyPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ acknowledgedReductions: [reduction.key], acknowledgedHeld: [] })
    )
  )
})

const session = (sessionId: number, adopted = false) => ({
  sessionId,
  startedAt: `2026-09-2${sessionId}`,
  durationMinutes: 10,
  adopted
})
const row = (sessionId: number, conversationId: string | null, reason: string | null = null) => ({
  sessionId,
  conversationId,
  startedAt: `2026-09-2${sessionId}`,
  durationMinutes: 10,
  eligible: reason === null,
  adopted: false,
  reason
})

it('links whole conversations with one checkbox each and shows blocked groups', async () => {
  vi.mocked(window.api.workspace.reviewActivity).mockResolvedValue({
    success: true,
    data: {
      fingerprint: 'adoption-receipt',
      conversations: [
        {
          key: '["claude","chat"]',
          provider: 'claude',
          conversationId: 'chat',
          status: 'ready',
          reasons: [],
          pendingSessionIds: [1, 2],
          sessions: [session(1), session(2), session(3, true)]
        },
        {
          key: '["claude","held"]',
          provider: 'claude',
          conversationId: 'held',
          status: 'blocked',
          reasons: ['protected-history'],
          pendingSessionIds: [4],
          sessions: [session(4)]
        },
        {
          key: '["claude","done"]',
          provider: 'claude',
          conversationId: 'done',
          status: 'linked',
          reasons: [],
          pendingSessionIds: [],
          sessions: [session(5, true)]
        }
      ],
      rows: [row(1, 'chat'), row(6, null, 'missing-conversation-id'), row(7, null, 'manual-entry')]
    }
  })
  vi.mocked(window.api.workspace.adoptActivity).mockResolvedValue({
    success: true,
    data: undefined
  })
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Review captured activity' }))
  const link = await screen.findByRole('button', { name: 'Link selected conversations' })
  expect(link).toBeDisabled()
  expect(screen.getAllByRole('checkbox')).toHaveLength(3)
  const blocked = screen.getByRole('checkbox', { name: /held .*Blocked: protected history/ })
  expect(blocked).toBeDisabled()
  expect(blocked).not.toBeChecked()
  const linked = screen.getByRole('checkbox', { name: /done .*Linked/ })
  expect(linked).toBeDisabled()
  expect(linked).toBeChecked()
  expect(screen.getByText(/Saved session 6 .*Cannot link: missing conversation id/)).toBeVisible()
  expect(screen.queryByText(/Saved session 7/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('checkbox', { name: /chat .*3 saved sessions .*Ready to link/ }))
  fireEvent.click(link)
  await waitFor(() =>
    expect(window.api.workspace.adoptActivity).toHaveBeenCalledWith('adoption-receipt', [1, 2])
  )
})
