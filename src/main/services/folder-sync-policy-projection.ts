import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { folderSyncSettings } from '../db/schema/folder-sync'
import { AppError } from '../../shared/types/ipc'
import { readTrackingPolicy } from '../../shared/tracking-policy'
import { canonicalJson } from './folder-sync-protocol'
import { syncFactChangeId } from './folder-sync-activity-records'
import { sharedWorkspacePolicyView } from './folder-sync-policy-records'
import { adoptInitialWorkspacePolicy, getWorkspacePolicy } from './workspace-policy'
import { previewSessionMappingTransitions } from './session-mapping-transitions'
import { planSessionMappingApplication } from './session-mapping-plan'
import { applySessionMappingApplication } from './session-mapping-application'

export type SharedPolicyProjection =
  | { status: 'unconfigured' | 'waiting' | 'conflict' | 'ready' | 'applied' }
  | { status: 'review-required'; reasons: string[] }

/**
 * The logical shared policy is retained even if this computer's saved edits need review.
 * A safe local recalculation uses the existing mapping transaction and preserves billing.
 * No imported policy silently acknowledges lost coverage or conflicting local assignments.
 */
export function projectSharedWorkspacePolicy<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>
): SharedPolicyProjection {
  return db.transaction((tx) => {
    const connection = tx
      .select()
      .from(folderSyncSettings)
      .where(eq(folderSyncSettings.slot, 1))
      .get()
    if (!connection) return { status: 'unconfigured' }
    const view = sharedWorkspacePolicyView(tx, connection.workspaceId)
    if (view.lifecycle === 'missing' || view.deferred.length) return { status: 'waiting' }
    if (view.lifecycle !== 'present' || view.conflicts.length) return { status: 'conflict' }
    const candidate = readTrackingPolicy(view.fields.policy.value)
    const local = getWorkspacePolicy(tx)
    if (!local) {
      // Setup must bind a blank installation to the selected shared history explicitly.
      if (connection.policyWorkspaceId !== connection.workspaceId)
        throw new AppError(
          'SYNC_POLICY_BINDING_REQUIRED',
          'Complete shared-history setup before importing its policy.'
        )
      adoptInitialWorkspacePolicy(tx, {
        workspaceId: connection.workspaceId,
        revisionId: syncFactChangeId(
          connection.workspaceId,
          'workspace-policy',
          canonicalJson(view.heads)
        ),
        policy: candidate
      })
      return { status: 'applied' }
    }
    if (connection.policyWorkspaceId !== local.workspaceId)
      throw new AppError(
        'SYNC_POLICY_BINDING_REQUIRED',
        'This connection does not match the local history selected during setup.'
      )
    if (canonicalJson(candidate) === canonicalJson(local.policy)) return { status: 'ready' }
    const preview = previewSessionMappingTransitions(tx, candidate)
    const decisionId = randomUUID()
    const plan = planSessionMappingApplication(preview, decisionId)
    const reasons: string[] = [...new Set(plan.conversations.flatMap((row) => row.heldReasons))]
    if (plan.coverageReductions.length) reasons.push('coverage-reduction')
    if (plan.retainedWithoutActivity.length) reasons.push('saved-history-without-activity')
    if (reasons.length) return { status: 'review-required', reasons }
    applySessionMappingApplication(tx, {
      decisionId,
      candidate,
      expectedFingerprint: preview.fingerprint,
      choices: [],
      acknowledgedHeld: []
    })
    return { status: 'applied' }
  })
}
