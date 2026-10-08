import type { FolderSyncJoinDecision, FolderSyncJoinReview } from './types/folder-sync'

/** Match unique names within the same client; leave ambiguous identities for a person. */
export function automaticJoinDecisions(review: FolderSyncJoinReview): FolderSyncJoinDecision[] {
  const decisions: FolderSyncJoinDecision[] = []
  for (const entityType of ['client', 'project'] as const) {
    const candidates = review.local.filter((row) => row.entityType === entityType)
    const options = new Map(
      candidates.map((row) => {
        const client = decisions.find(
          (item) => item.entityType === 'client' && item.localSyncId === row.clientLocalSyncId
        )
        const clientId = row.clientSharedId ?? (client?.action === 'link' ? client.sharedId : null)
        return [
          row.localSyncId,
          review.shared.filter(
            (shared) =>
              shared.entityType === entityType &&
              !shared.localSyncId &&
              row.suggestions.includes(shared.entityId) &&
              !shared.conflicts.length &&
              (entityType === 'client' || shared.clientSyncId === clientId)
          )
        ]
      })
    )
    for (const row of candidates) {
      const matches = options.get(row.localSyncId)!
      if (
        matches.length === 1 &&
        [...options.values()].filter((items) =>
          items.some((item) => item.entityId === matches[0].entityId)
        ).length === 1
      ) {
        decisions.push({
          entityType,
          localSyncId: row.localSyncId,
          action: 'link',
          sharedId: matches[0].entityId
        })
      } else {
        decisions.push({ entityType, localSyncId: row.localSyncId, action: 'separate' })
      }
    }
  }
  return decisions
}
