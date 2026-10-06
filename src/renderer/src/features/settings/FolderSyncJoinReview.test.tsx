import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FolderSyncJoinReview } from './FolderSyncJoinReview'
import type {
  FolderSyncJoinReview as Review,
  FolderSyncState
} from '../../../../shared/types/folder-sync'

let cache: QueryClient
const success = <T,>(data: T) => ({ success: true as const, data })
const review: Review = {
  workspaceId: 'history-1',
  required: true,
  fingerprint: 'shown',
  sharedClientNames: ['Acme'],
  local: [
    {
      entityType: 'client',
      localSyncId: 'local-acme',
      name: 'Acme',
      values: { color: '#445566', billableRate: 120 },
      suggestions: ['shared-acme']
    },
    {
      entityType: 'project',
      localSyncId: 'local-site',
      name: 'Site',
      values: { hourlyRate: null },
      clientLocalSyncId: 'local-acme',
      clientName: 'Acme',
      clientSharedId: null,
      suggestions: ['shared-site']
    }
  ],
  shared: [
    {
      entityType: 'client',
      entityId: 'shared-acme',
      name: 'Acme',
      clientSyncId: null,
      clientName: null,
      values: { color: '#112233', billableRate: 100 },
      conflicts: []
    },
    {
      entityType: 'project',
      entityId: 'shared-site',
      name: 'Site',
      clientSyncId: 'shared-acme',
      clientName: 'Acme',
      values: { hourlyRate: null },
      conflicts: []
    }
  ]
}
const applied = { joinReviewRequired: false } as FolderSyncState
beforeEach(() => {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('api', {
    folderSync: {
      joinReview: vi.fn().mockResolvedValue(success(review)),
      applyJoinReview: vi.fn().mockResolvedValue(success(applied))
    }
  })
})
afterEach(() => {
  cleanup()
  cache.clear()
  vi.unstubAllGlobals()
})

function show() {
  const onApplied = vi.fn()
  render(
    <QueryClientProvider client={cache}>
      <FolderSyncJoinReview onApplied={onApplied} />
    </QueryClientProvider>
  )
  return onApplied
}
it('automatically links clear matches and adds unmatched local projects', async () => {
  const data = structuredClone(review)
  data.local[1].directoryPath = 'C:/projects/site'
  data.local.push({
    ...data.local[1],
    localSyncId: 'new-project',
    name: 'New app',
    suggestions: [],
    directoryPath: 'C:/projects/new'
  })
  vi.mocked(window.api.folderSync.joinReview).mockResolvedValue(success(data))
  const onApplied = show()
  await waitFor(() =>
    expect(window.api.folderSync.applyJoinReview).toHaveBeenCalledWith({
      fingerprint: 'shown',
      folders: [],
      decisions: [
        {
          entityType: 'client',
          localSyncId: 'local-acme',
          action: 'link',
          sharedId: 'shared-acme'
        },
        {
          entityType: 'project',
          localSyncId: 'local-site',
          action: 'link',
          sharedId: 'shared-site'
        },
        { entityType: 'project', localSyncId: 'new-project', action: 'separate' }
      ]
    })
  )
  await waitFor(() => expect(onApplied).toHaveBeenCalledWith(applied))
})
it('prompts only for shared projects without a disk match and saves a selected folder', async () => {
  vi.stubGlobal('api', {
    ...window.api,
    dialog: { openFolder: vi.fn().mockResolvedValue(success('D:/work/site')) }
  })
  show()
  const choose = await screen.findByRole('button', { name: 'Choose folder for Site' })
  expect(window.api.folderSync.applyJoinReview).not.toHaveBeenCalled()
  expect(screen.queryByRole('combobox', { name: 'Match client Acme' })).not.toBeInTheDocument()
  fireEvent.click(choose)
  await screen.findByText('D:/work/site')
  fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }))
  await waitFor(() =>
    expect(window.api.folderSync.applyJoinReview).toHaveBeenCalledWith(
      expect.objectContaining({
        folders: [{ sharedId: 'shared-site', directoryPath: 'D:/work/site' }]
      })
    )
  )
})
it('allows shared history without a local checkout', async () => {
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'Not on this computer: Site' }))
  fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }))
  await waitFor(() =>
    expect(window.api.folderSync.applyJoinReview).toHaveBeenCalledWith(
      expect.objectContaining({
        folders: [],
        decisions: expect.arrayContaining([
          {
            entityType: 'project',
            localSyncId: 'local-site',
            action: 'link',
            sharedId: 'shared-site'
          }
        ])
      })
    )
  )
})
it('does not retry a failed automatic match without user action', async () => {
  const data = structuredClone(review)
  data.local[1].directoryPath = 'C:/projects/site'
  vi.mocked(window.api.folderSync.joinReview).mockResolvedValue(success(data))
  vi.mocked(window.api.folderSync.applyJoinReview).mockResolvedValue({
    success: false,
    error: { code: 'SYNC_ERROR', message: 'Could not connect.' }
  })
  show()
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not connect.')
  expect(window.api.folderSync.applyJoinReview).toHaveBeenCalledTimes(1)
})

it('maps a differently named local project without creating a second shared project', async () => {
  const data = structuredClone(review)
  data.local[1] = {
    ...data.local[1],
    name: 'Laptop checkout',
    suggestions: [],
    directoryPath: 'D:/work/site'
  }
  vi.mocked(window.api.folderSync.joinReview).mockResolvedValue(success(data))
  show()
  const select = await screen.findByRole('combobox', { name: 'Local project for Site' })
  expect(window.api.folderSync.applyJoinReview).not.toHaveBeenCalled()
  fireEvent.change(select, { target: { value: 'local-site' } })
  fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }))
  await waitFor(() =>
    expect(window.api.folderSync.applyJoinReview).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: [
          {
            entityType: 'client',
            localSyncId: 'local-acme',
            action: 'link',
            sharedId: 'shared-acme'
          },
          {
            entityType: 'project',
            localSyncId: 'local-site',
            action: 'link',
            sharedId: 'shared-site'
          }
        ]
      })
    )
  )
})

it.each([
  [false, 'no checkout'],
  [true, 'no checkout'],
  [false, 'different checkout'],
  [true, 'different checkout']
] as const)(
  'clears a tentative project and inferred client match (renamed client: %s, %s)',
  async (renamedClient, choice) => {
    const data = structuredClone(review)
    data.local[1] = {
      ...data.local[1],
      name: 'Other project',
      suggestions: [],
      directoryPath: 'C:/other'
    }
    if (renamedClient) data.local[0] = { ...data.local[0], name: 'Personal', suggestions: [] }
    vi.mocked(window.api.folderSync.joinReview).mockResolvedValue(success(data))
    vi.stubGlobal('api', {
      ...window.api,
      dialog: { openFolder: vi.fn().mockResolvedValue(success('C:/new-checkout')) }
    })
    show()
    fireEvent.change(await screen.findByRole('combobox', { name: 'Local project for Site' }), {
      target: { value: 'local-site' }
    })
    if (choice === 'different checkout') {
      fireEvent.click(screen.getByRole('button', { name: 'Choose folder for Site' }))
      await screen.findByText('C:/new-checkout')
    } else fireEvent.click(screen.getByRole('button', { name: 'Not on this computer: Site' }))
    expect(screen.queryByText('C:/other')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }))
    await waitFor(() =>
      expect(window.api.folderSync.applyJoinReview).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: expect.arrayContaining([
            { entityType: 'project', localSyncId: 'local-site', action: 'separate' }
          ]),
          folders:
            choice === 'different checkout'
              ? [{ sharedId: 'shared-site', directoryPath: 'C:/new-checkout' }]
              : []
        })
      )
    )
    if (renamedClient)
      expect(window.api.folderSync.applyJoinReview).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: expect.arrayContaining([
            { entityType: 'client', localSyncId: 'local-acme', action: 'separate' }
          ])
        })
      )
  }
)

it('keeps manual choices through a temporary delivery pause', async () => {
  const data = structuredClone(review)
  data.local[1] = {
    ...data.local[1],
    name: 'Local checkout',
    suggestions: [],
    directoryPath: 'C:/site'
  }
  vi.mocked(window.api.folderSync.joinReview).mockResolvedValue(success(data))
  const tree = (ready: boolean) => (
    <QueryClientProvider client={cache}>
      <FolderSyncJoinReview ready={ready} onApplied={() => {}} />
    </QueryClientProvider>
  )
  const view = render(tree(true))
  fireEvent.change(await screen.findByRole('combobox', { name: 'Local project for Site' }), {
    target: { value: 'local-site' }
  })
  view.rerender(tree(false))
  expect(screen.getByRole('button', { name: 'Finish connecting' })).toBeDisabled()
  view.rerender(tree(true))
  expect(screen.getByRole('combobox', { name: 'Local project for Site' })).toHaveValue('local-site')
  fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }))
  await waitFor(() =>
    expect(window.api.folderSync.applyJoinReview).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: expect.arrayContaining([
          {
            entityType: 'project',
            localSyncId: 'local-site',
            action: 'link',
            sharedId: 'shared-site'
          }
        ])
      })
    )
  )
})

it('restores the original automatic match after cancelling a manual replacement', async () => {
  const data = structuredClone(review)
  data.local.push({
    ...data.local[1],
    localSyncId: 'other-local',
    name: 'Other',
    suggestions: [],
    directoryPath: 'C:/other'
  })
  vi.mocked(window.api.folderSync.joinReview).mockResolvedValue(success(data))
  show()
  fireEvent.change(await screen.findByRole('combobox', { name: 'Local project for Site' }), {
    target: { value: 'other-local' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Not on this computer: Site' }))
  fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }))
  await waitFor(() =>
    expect(window.api.folderSync.applyJoinReview).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: expect.arrayContaining([
          {
            entityType: 'project',
            localSyncId: 'local-site',
            action: 'link',
            sharedId: 'shared-site'
          },
          { entityType: 'project', localSyncId: 'other-local', action: 'separate' }
        ])
      })
    )
  )
})

it('allows replacing a manual match from another previously unmatched client', async () => {
  const data = structuredClone(review)
  data.local[0] = { ...data.local[0], name: 'Personal', suggestions: [] }
  data.local[1] = {
    ...data.local[1],
    name: 'Local checkout',
    suggestions: [],
    directoryPath: 'C:/site'
  }
  data.local.push({ ...data.local[0], localSyncId: 'other-client', name: 'Other client' })
  data.local.push({
    ...data.local[1],
    localSyncId: 'other-local',
    name: 'Other checkout',
    clientLocalSyncId: 'other-client',
    directoryPath: 'C:/other'
  })
  vi.mocked(window.api.folderSync.joinReview).mockResolvedValue(success(data))
  show()
  const select = await screen.findByRole('combobox', { name: 'Local project for Site' })
  fireEvent.change(select, { target: { value: 'local-site' } })
  fireEvent.change(select, { target: { value: 'other-local' } })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }))
  await waitFor(() =>
    expect(window.api.folderSync.applyJoinReview).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: expect.arrayContaining([
          { entityType: 'client', localSyncId: 'local-acme', action: 'separate' },
          {
            entityType: 'client',
            localSyncId: 'other-client',
            action: 'link',
            sharedId: 'shared-acme'
          },
          { entityType: 'project', localSyncId: 'local-site', action: 'separate' },
          {
            entityType: 'project',
            localSyncId: 'other-local',
            action: 'link',
            sharedId: 'shared-site'
          }
        ])
      })
    )
  )
})

it('retains a folderless reassignment without restoring it into an occupied shared project', async () => {
  const data = structuredClone(review)
  data.local.push({
    ...data.local[1],
    localSyncId: 'replacement',
    name: 'Other checkout',
    suggestions: [],
    directoryPath: 'C:/other'
  })
  data.shared.push({ ...data.shared[1], entityId: 'other-shared', name: 'Other' })
  vi.mocked(window.api.folderSync.joinReview).mockResolvedValue(success(data))
  show()
  fireEvent.change(await screen.findByRole('combobox', { name: 'Local project for Site' }), {
    target: { value: 'replacement' }
  })
  fireEvent.change(screen.getByRole('combobox', { name: 'Local project for Other' }), {
    target: { value: 'local-site' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Not on this computer: Other' }))
  fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }))
  await waitFor(() =>
    expect(window.api.folderSync.applyJoinReview).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: expect.arrayContaining([
          {
            entityType: 'project',
            localSyncId: 'local-site',
            action: 'link',
            sharedId: 'other-shared'
          },
          {
            entityType: 'project',
            localSyncId: 'replacement',
            action: 'link',
            sharedId: 'shared-site'
          }
        ])
      })
    )
  )
})

it.each(['choose folder', 'no checkout'])(
  'retains a manual folderless project match with %s',
  async (choice) => {
    const data = structuredClone(review)
    data.local[1] = {
      ...data.local[1],
      name: 'Renamed project',
      suggestions: [],
      directoryPath: null
    }
    vi.mocked(window.api.folderSync.joinReview).mockResolvedValue(success(data))
    vi.stubGlobal('api', {
      ...window.api,
      dialog: { openFolder: vi.fn().mockResolvedValue(success('C:/new-checkout')) }
    })
    show()
    fireEvent.change(await screen.findByRole('combobox', { name: 'Local project for Site' }), {
      target: { value: 'local-site' }
    })
    expect(screen.getByRole('button', { name: 'Finish connecting' })).toBeDisabled()
    if (choice === 'choose folder') {
      fireEvent.click(screen.getByRole('button', { name: 'Choose folder for Site' }))
      await screen.findByText('C:/new-checkout')
    } else fireEvent.click(screen.getByRole('button', { name: 'Not on this computer: Site' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }))
    await waitFor(() =>
      expect(window.api.folderSync.applyJoinReview).toHaveBeenCalledWith(
        expect.objectContaining({
          decisions: expect.arrayContaining([
            {
              entityType: 'project',
              localSyncId: 'local-site',
              action: 'link',
              sharedId: 'shared-site'
            }
          ]),
          folders:
            choice === 'choose folder'
              ? [{ sharedId: 'shared-site', directoryPath: 'C:/new-checkout' }]
              : []
        })
      )
    )
  }
)

it("rejects browsing to another shared project's automatically matched folder", async () => {
  const data = structuredClone(review)
  data.local[1].directoryPath = 'C:/site'
  data.shared.push({ ...data.shared[1], entityId: 'other-shared', name: 'Other' })
  vi.mocked(window.api.folderSync.joinReview).mockResolvedValue(success(data))
  vi.stubGlobal('api', {
    ...window.api,
    dialog: { openFolder: vi.fn().mockResolvedValue(success('C:/site')) }
  })
  show()
  fireEvent.click(await screen.findByRole('button', { name: 'Choose folder for Other' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/already matched/)
  fireEvent.click(screen.getByRole('button', { name: 'Not on this computer: Other' }))
  fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }))
  await waitFor(() =>
    expect(window.api.folderSync.applyJoinReview).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: expect.arrayContaining([
          {
            entityType: 'project',
            localSyncId: 'local-site',
            action: 'link',
            sharedId: 'shared-site'
          }
        ])
      })
    )
  )
})
