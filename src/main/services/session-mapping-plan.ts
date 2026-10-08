import { createHash } from 'node:crypto'
import { AppError } from '../../shared/types/ipc'
import { requireExplicitTimestamp } from '../../shared/tracking-policy'
import type { SessionModelUsage } from '../../shared/types/session'
import { retainsCanonicalEvent, type CanonicalEventReference } from './canonical-activity'
import type { CodexUsageReference } from './canonical-codex'
import {
  relateCanonicalIntervals,
  canonicalUsageKey,
  sameCanonicalInterval,
  type calculateCanonicalIntervals,
  type CanonicalIntervalCoverage
} from './canonical-intervals'
import type { previewSessionMappingTransitions } from './session-mapping-transitions'
import { isMappedHistoryDeletion } from './workspace-policy'

type Preview = ReturnType<typeof previewSessionMappingTransitions>
type Saved = Preview['history']['saved']
type Interval = ReturnType<typeof calculateCanonicalIntervals>[number]
type Session = Saved['sessions'][number]
// Current immutable revision once stored; an adopted origin is referenced by its mapping id.
type Mapping = Saved['activityMappings'][number] & { revisionId?: string | null }
type TimeField = 'startedAt' | 'endedAt' | 'durationMinutes'
type MetadataField = 'projectPath' | 'projectId' | 'clientId' | 'description' | 'billable'

export type SessionMappingHeldReason =
  | 'unresolved-activity'
  | 'deleted-history'
  | 'audit-only-history'
  | 'protected-history'
  | 'running-session'
  | 'missing-baseline'
  | 'invalid-saved-time'
  | 'unadopted-history'
  | 'partial-adoption'
  | 'invalid-mapping'
  | 'changed-or-missing-evidence'
  | 'saved-row-diverged'
  | 'overlapping-predecessors'
  | 'unmatched-predecessor'
  | 'complex-relationship'
  | 'lost-event-coverage'
  | 'lost-continuity-coverage'
  | 'lost-usage-coverage'
  | 'time-override-in-split-or-merge'
  | 'invalid-preserved-time'
  | 'metadata-choice-required'
  | 'history-operation-conflict'

/** Explicit metadata source for one candidate successor, never inferred from list order. */
export interface SessionMappingSourceChoice {
  provider: string
  conversationId: string
  afterIndex: number
  sourceSessionId: number
}

export type SessionMappingMetadata = Pick<Session, MetadataField>

export interface SessionMappingSuccessorPlan {
  afterIndex: number
  kind: 'adopt' | 'continue' | 'policy' | 'split' | 'merge'
  interval: Interval
  coverageHash: string
  /** Local row that continues in place; null inserts a row and retires every predecessor. */
  keepSessionId: number | null
  predecessorSessionIds: number[]
  predecessorMappingIds: string[]
  predecessorRevisionIds: string[]
  sourceSessionId: number | null
  metadata: SessionMappingMetadata | null
  conflictingFields: MetadataField[]
  preservedTimeFields: TimeField[]
  timeOverrides: Record<TimeField, 0 | 1>
  effective: Pick<Interval, TimeField>
  policyChanged: boolean
  intervalUnchanged: boolean
  mappingId: string
  revisionId: string
}

export interface SessionMappingConversationPlan {
  provider: string
  conversationId: string
  status: 'applicable' | 'held'
  heldReasons: SessionMappingHeldReason[]
  requiredChoices: Array<{
    afterIndex: number
    candidateSessionIds: number[]
    conflictingFields: MetadataField[]
  }>
  activeSessionIds: number[]
  retiredSessionIds: number[]
  successors: SessionMappingSuccessorPlan[]
  /**
   * Candidate-policy coverage explicitly deleted from history (absent without deletions).
   * It is never a successor, but it orders later work like a kept interval would.
   */
  suppressed?: Array<{ sessionIds: number[]; startedAt: string; endedAt: string }>
}

export interface SessionMappingCoverageReduction {
  key: string
  provider: string
  conversationId: string
  uncountedEvents: CanonicalEventReference[]
  removedContinuity: CanonicalIntervalCoverage['continuity']
  uncountedUsage: CodexUsageReference[]
  beforeMinutes: number
  afterMinutes: number
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const timeFields = ['startedAt', 'endedAt', 'durationMinutes'] as const
const metadataFields = ['projectPath', 'projectId', 'clientId', 'description', 'billable'] as const

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function validTimes(value: Pick<Interval, TimeField>): boolean {
  try {
    requireExplicitTimestamp(value.startedAt)
    requireExplicitTimestamp(value.endedAt)
    return (
      Date.parse(value.startedAt) <= Date.parse(value.endedAt) &&
      Number.isFinite(value.durationMinutes) &&
      value.durationMinutes >= 0
    )
  } catch {
    return false
  }
}
function sameTimes(a: Pick<Interval, TimeField>, b: Pick<Interval, TimeField>): boolean {
  return (
    Date.parse(a.startedAt) === Date.parse(b.startedAt) &&
    Date.parse(a.endedAt) === Date.parse(b.endedAt) &&
    a.durationMinutes === b.durationMinutes
  )
}
function usage(rows: SessionModelUsage[]): string {
  return JSON.stringify(
    rows
      .map((row) => ({
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreationInputTokens: row.cacheCreationInputTokens,
        cacheReadInputTokens: row.cacheReadInputTokens
      }))
      .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
  )
}
function sameCounts(
  a: Pick<Interval, 'promptCount' | 'inputTokens' | 'outputTokens'>,
  aUsage: SessionModelUsage[],
  b: Interval
): boolean {
  return (
    a.promptCount === b.promptCount &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    usage(aUsage) === usage(b.modelUsage)
  )
}
/** First counted fact; a message-free part between explicit cuts is anchored by its first gap. */
const first = (interval: Interval) => {
  const message = interval.coverage.messages[0]
  if (message) return message.eventId
  const edge = interval.coverage.continuity[0]
  return JSON.stringify([edge?.from.eventId, edge?.to.eventId, edge?.startedAt])
}
const counted = (coverage: CanonicalIntervalCoverage) => [
  ...coverage.messages,
  ...coverage.continuity.flatMap((edge) => edge.progress)
]

/** Every counted event and every measured gap span must land, unchanged, in the successors. */
function coverageLoss(
  previous: CanonicalIntervalCoverage,
  successors: CanonicalIntervalCoverage[]
) {
  const retained = successors.flatMap(counted)
  const edges = successors.flatMap((coverage) => coverage.continuity)
  const lostEvents = counted(previous).filter(
    (item) => !retained.some((current) => retainsCanonicalEvent(item, current))
  )
  const retainedUsage = new Set(
    successors.flatMap((coverage) => (coverage.usage ?? []).map(canonicalUsageKey))
  )
  const lostUsage = (previous.usage ?? []).filter(
    (item) => !retainedUsage.has(canonicalUsageKey(item))
  )
  const lostContinuity = previous.continuity.filter((edge) => {
    const spans = edges
      .filter(
        (later) =>
          retainsCanonicalEvent(edge.from, later.from) && retainsCanonicalEvent(edge.to, later.to)
      )
      .map((later) => [Date.parse(later.startedAt), Date.parse(later.endedAt)])
      .sort((a, b) => a[0] - b[0])
    const end = Date.parse(edge.endedAt)
    let covered = Date.parse(edge.startedAt)
    for (const [start, stop] of spans) {
      if (start > covered) break
      covered = Math.max(covered, stop)
    }
    return covered < end
  })
  return {
    events: !!lostEvents.length,
    continuity: !!lostContinuity.length,
    usage: !!lostUsage.length,
    lostUsage,
    lostEvents,
    lostContinuity
  }
}
export function coverageHash(
  provider: string,
  conversationId: string,
  coverage: CanonicalIntervalCoverage
): string {
  const ref = (item: CanonicalEventReference) => [
    item.eventId,
    item.observationId,
    item.kind,
    item.timestamp,
    ...(item.observationIds ? [[...item.observationIds].sort()] : [])
  ]
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: coverage.version,
        provider,
        conversationId,
        messages: coverage.messages.map(ref),
        continuity: coverage.continuity.map((edge) => [
          ref(edge.from),
          ref(edge.to),
          edge.startedAt,
          edge.endedAt,
          edge.progress.map(ref)
        ]),
        ...(coverage.version === 2 ? { usage: coverage.usage!.map(canonicalUsageKey) } : {})
      })
    )
    .digest('hex')
}
/** RFC 9562 version 8 layout over sha256, so replaying a decision yields the same identities. */
export function derivedUuid(namespace: string, decisionId: string, hash: string): string {
  const bytes = createHash('sha256')
    .update(`${namespace}\0${decisionId}\0${hash}`)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const conversationKey = (provider: string, conversationId: string) =>
  JSON.stringify([provider, conversationId])

function readChoices(value: unknown): SessionMappingSourceChoice[] {
  const invalid = () =>
    new AppError(
      'INVALID_MAPPING_CHOICE',
      'Choose at most one saved source per successor from the reviewed plan'
    )
  if (!Array.isArray(value)) throw invalid()
  const seen = new Set<string>()
  return value
    .map((item: unknown) => {
      if (
        !object(item) ||
        Object.keys(item).length !== 4 ||
        typeof item.provider !== 'string' ||
        typeof item.conversationId !== 'string' ||
        typeof item.afterIndex !== 'number' ||
        !Number.isSafeInteger(item.afterIndex) ||
        item.afterIndex < 0 ||
        typeof item.sourceSessionId !== 'number' ||
        !Number.isSafeInteger(item.sourceSessionId) ||
        item.sourceSessionId <= 0
      )
        throw invalid()
      const key = JSON.stringify([item.provider, item.conversationId, item.afterIndex])
      if (seen.has(key)) throw invalid()
      seen.add(key)
      return {
        provider: item.provider,
        conversationId: item.conversationId,
        afterIndex: item.afterIndex,
        sourceSessionId: item.sourceSessionId
      }
    })
    .sort((a, b) => {
      const left = JSON.stringify([a.provider, a.conversationId, a.afterIndex])
      const right = JSON.stringify([b.provider, b.conversationId, b.afterIndex])
      return left < right ? -1 : left > right ? 1 : 0
    })
}

/**
 * Pure per-conversation application plan over one transition preview. No reads or writes:
 * apply must recheck the preview fingerprint and recompute this plan in its own transaction.
 * Ordinary ambiguity is returned as held; only malformed requests throw.
 */
export function planSessionMappingApplication(
  preview: Preview,
  decisionId: string,
  choices: readonly SessionMappingSourceChoice[] = [],
  acknowledgedReductions: readonly string[] = []
) {
  if (typeof decisionId !== 'string' || !uuid.test(decisionId))
    throw new AppError('INVALID_MAPPING_DECISION', 'A canonical decision UUID is required')
  if (
    !object(preview) ||
    preview.version !== 1 ||
    preview.scope !== 'adopted-mapping-transitions' ||
    !object(preview.history)
  )
    throw new AppError('INVALID_MAPPING_PREVIEW', 'A mapping transition preview is required')
  const selected = readChoices(choices)
  if (
    !Array.isArray(acknowledgedReductions) ||
    acknowledgedReductions.some((key) => typeof key !== 'string') ||
    new Set(acknowledgedReductions).size !== acknowledgedReductions.length
  )
    throw new AppError(
      'INVALID_COVERAGE_ACKNOWLEDGMENT',
      'Review the exact proposed coverage reductions'
    )
  const coverageReductions: SessionMappingCoverageReduction[] = []
  const { history } = preview
  const { saved } = history
  const rows = new Map(saved.sessions.map((row) => [row.id, row]))
  const comparisons = new Map(history.comparisons.map((row) => [row.sessionId, row]))
  const baselines = new Map(saved.derivations.map((row) => [row.sessionId, row]))
  const overrides = new Map(saved.timeOverrides.map((row) => [row.sessionId, row]))
  const mappings = new Map<number, Mapping>(
    saved.activityMappings.map((row) => [row.sessionId, row])
  )
  const transitions = new Map(preview.mappings.map((row) => [row.mappingId, row]))
  const deleted = new Set(saved.deletions.map((row) => row.sessionId))
  // Deleted adopted rows are ledger masks; every other deletion still holds its conversation.
  const masked = new Map(
    saved.deletions
      .filter((row) => isMappedHistoryDeletion(row, mappings))
      .map((row) => [row.sessionId, row])
  )
  const modelUsage = new Map<number, SessionModelUsage[]>()
  for (const row of saved.modelUsage) {
    const rowsForSession = modelUsage.get(row.sessionId) ?? []
    rowsForSession.push(row)
    modelUsage.set(row.sessionId, rowsForSession)
  }
  // Frozen refs are authoritative; unfrozen invoice line items still count as billed work.
  const billed = new Set([
    ...saved.billingRefs.map((row) => row.sessionId),
    ...saved.invoiceLineItems.flatMap((row) =>
      (row.sessionIds ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => /^\d+$/.test(id))
        .map(Number)
    )
  ])
  const currentPolicy = JSON.stringify(history.currentPolicy)
  const candidatePolicy = JSON.stringify(history.candidatePolicy)

  const invalidChoice = () =>
    new AppError(
      'INVALID_MAPPING_CHOICE',
      'A selected metadata source does not belong to that successor'
    )
  const known = new Map(
    history.conversations.map((row) => [conversationKey(row.provider, row.conversationId), row])
  )
  const chosen = new Map<string, Map<number, number>>()
  for (const choice of selected) {
    const key = conversationKey(choice.provider, choice.conversationId)
    const conversation = known.get(key)
    if (
      !conversation ||
      conversation.status !== 'resolved' ||
      choice.afterIndex >= conversation.after.length ||
      !conversation.savedSessionIds.includes(choice.sourceSessionId)
    )
      throw invalidChoice()
    const entries = chosen.get(key) ?? new Map<number, number>()
    chosen.set(key, entries.set(choice.afterIndex, choice.sourceSessionId))
  }

  const conversations = history.conversations.map((conversation) => {
    const held = new Set<SessionMappingHeldReason>()
    const active = conversation.savedSessionIds
      .filter((id) => comparisons.get(id)?.disposition === 'active')
      .map((id) => rows.get(id)!)
    const result = (
      requiredChoices: SessionMappingConversationPlan['requiredChoices'] = []
    ): SessionMappingConversationPlan => ({
      provider: conversation.provider,
      conversationId: conversation.conversationId,
      status: 'held',
      heldReasons: [...held].sort(),
      requiredChoices,
      activeSessionIds: active.map((row) => row.id),
      retiredSessionIds: [],
      successors: []
    })

    // Row-level preconditions. Audit rows only block through deletion or the history
    // preview's own protections; a later clean head is judged by its active rows.
    if (conversation.status !== 'resolved') held.add('unresolved-activity')
    if (conversation.savedSessionIds.some((id) => deleted.has(id) && !masked.has(id)))
      held.add('deleted-history')
    // A conversation whose adopted rows were all explicitly deleted is still managed:
    // its masks keep old work suppressed while independent later work is planned.
    if (
      conversation.savedSessionIds.length &&
      !active.length &&
      !conversation.savedSessionIds.some((id) => mappings.has(id))
    )
      held.add('audit-only-history')
    const operations = conversation.status === 'resolved' ? conversation.operations : undefined
    if (
      operations &&
      (operations.invalid.length ||
        operations.conflicts.before.length ||
        operations.conflicts.after.length)
    )
      held.add('history-operation-conflict')
    const mapped = active.filter((row) => mappings.has(row.id))
    if (active.length && !mapped.length) held.add('unadopted-history')
    else if (mapped.length < active.length) held.add('partial-adoption')
    for (const row of active) {
      const comparison = comparisons.get(row.id)!
      if (comparison.status === 'review-required' && comparison.reason === 'protected-history')
        held.add('protected-history')
      if (row.status !== 'completed') held.add('running-session')
      const baseline = baselines.get(row.id)
      if (!baseline) held.add('missing-baseline')
      else if (!validTimes(row) || !validTimes(baseline)) held.add('invalid-saved-time')
      const mapping = mappings.get(row.id)
      const transition = mapping && transitions.get(mapping.id)
      if (mapping && !transition) held.add('invalid-mapping')
      if (transition?.status === 'review-required') held.add(transition.reason)
    }
    if (held.size || conversation.status !== 'resolved') return result()
    const { provider, conversationId, before, after } = conversation

    // Saved coverage: the adopted snapshot, or its in-place growth under the same policy.
    const predecessors = mapped.map((row) => {
      const mapping = mappings.get(row.id)!
      const snapshot = JSON.parse(mapping.intervalJson) as Interval
      const baseline = baselines.get(row.id)!
      const pool = [
        ...(mapping.policyJson === currentPolicy ? before : []),
        ...(mapping.policyJson === candidatePolicy ? after : [])
      ]
      const effective = sameTimes(baseline, snapshot)
        ? snapshot
        : pool.find((interval) => {
            const loss = coverageLoss(snapshot.coverage, [interval.coverage])
            return (
              first(interval) === first(snapshot) &&
              interval.startedAt === snapshot.startedAt &&
              sameTimes(baseline, interval) &&
              !loss.events &&
              !loss.continuity &&
              !loss.usage
            )
          })
      if (!effective || !sameCounts(row, modelUsage.get(row.id) ?? [], effective))
        held.add('saved-row-diverged')
      const flags = overrides.get(row.id)
      const preserved = timeFields.filter(
        (field) =>
          !!flags?.[field] ||
          (field === 'durationMinutes'
            ? row[field] !== baseline[field]
            : Date.parse(row[field]) !== Date.parse(baseline[field]))
      )
      return {
        row,
        mapping,
        effective: effective ?? snapshot,
        preserved,
        billed: billed.has(row.id)
      }
    })
    const claimed = new Set<string>()
    for (const { effective } of predecessors)
      for (const item of counted(effective.coverage)) {
        if (claimed.has(item.eventId)) held.add('overlapping-predecessors')
        claimed.add(item.eventId)
      }
    if (held.size) return result()

    // Relationship labels are evidence only; applicability also needs complete coverage.
    const predecessorsOf = relateCanonicalIntervals(
      predecessors.map((entry) => entry.effective),
      after
    ).map((link) => link.predecessors.map((entry) => entry.beforeIndex))
    const successorsOf = predecessors.map((_, index) =>
      predecessorsOf.flatMap((indices, afterIndex) => (indices.includes(index) ? [afterIndex] : []))
    )
    // Coverage a trusted portable deletion fact already suppresses is not lost; the row is
    // trimmed and must retire (its original stays audit history), never shrink in place.
    const deletedElsewhere = (operations?.suppressed.after ?? []).flatMap((row) =>
      row.operationIds.length && row.coverage ? [row.coverage] : []
    )
    const trimmed = new Set<number>()
    const losses = predecessors.map((entry, index) => {
      const successors = successorsOf[index].map((j) => after[j].coverage)
      const loss = coverageLoss(entry.effective.coverage, successors)
      if (!deletedElsewhere.length || (!loss.events && !loss.continuity && !loss.usage)) return loss
      const remaining = coverageLoss(entry.effective.coverage, [...successors, ...deletedElsewhere])
      if (remaining.events || remaining.continuity || remaining.usage) return loss
      trimmed.add(index)
      return remaining
    })
    const uncountedEvents = losses.flatMap((loss) => loss.lostEvents)
    const removedContinuity = losses.flatMap((loss) => loss.lostContinuity)
    const uncountedUsage = losses.flatMap((loss) => loss.lostUsage)
    let acknowledged = false
    if (uncountedEvents.length || removedContinuity.length || uncountedUsage.length) {
      const reduction = {
        provider,
        conversationId,
        uncountedEvents,
        removedContinuity,
        uncountedUsage,
        beforeMinutes: predecessors.reduce((sum, row) => sum + row.effective.durationMinutes, 0),
        afterMinutes: after.reduce((sum, row) => sum + row.durationMinutes, 0)
      }
      const key = createHash('sha256')
        .update(JSON.stringify([preview.fingerprint, reduction]))
        .digest('hex')
      coverageReductions.push({ key, ...reduction })
      // Only an explicit policy change may drop measured coverage. Backfills or
      // altered same-policy evidence always remain held for separate review.
      acknowledged = candidatePolicy !== currentPolicy && acknowledgedReductions.includes(key)
    }
    predecessors.forEach((entry, index) => {
      const successors = successorsOf[index]
      if (!successors.length) held.add('unmatched-predecessor')
      if (successors.length > 1 && successors.some((j) => predecessorsOf[j].length > 1))
        held.add('complex-relationship')
      const loss = losses[index]
      if (loss.events && !acknowledged) held.add('lost-event-coverage')
      if (loss.continuity && !acknowledged) held.add('lost-continuity-coverage')
      if (loss.usage && !acknowledged) held.add('lost-usage-coverage')
      if (
        entry.preserved.length &&
        (trimmed.has(index) ||
          successors.length > 1 ||
          successors.some((j) => predecessorsOf[j].length > 1))
      )
        held.add('time-override-in-split-or-merge')
    })
    if (held.size) return result()

    const choicesHere = chosen.get(conversationKey(provider, conversationId))
    const deletedSources = conversation.savedSessionIds.flatMap((id) => {
      const mapping = masked.has(id) ? mappings.get(id) : undefined
      if (!mapping) return []
      const snapshot = JSON.parse(mapping.intervalJson) as Interval
      return [{ row: rows.get(id)!, end: Date.parse(snapshot.endedAt) }]
    })
    const requiredChoices: SessionMappingConversationPlan['requiredChoices'] = []
    const successors = after.map((interval, afterIndex) => {
      const linked = predecessorsOf[afterIndex]
        .map((index) => predecessors[index])
        .sort((a, b) => a.row.id - b.row.id)
      const kind: SessionMappingSuccessorPlan['kind'] = !linked.length
        ? 'adopt'
        : linked.length > 1
          ? 'merge'
          : successorsOf[predecessors.indexOf(linked[0])].length > 1
            ? 'split'
            : linked[0].mapping.policyJson === candidatePolicy
              ? 'continue'
              : 'policy'
      // New intervals inherit assignment from the nearest preceding interval. A tie
      // remains a real choice; list order must never select a project or client. Only
      // when no kept row precedes new work does an explicitly deleted row supply it.
      const start = Date.parse(interval.startedAt)
      const earlierKept = predecessors
        .map((entry) => ({ row: entry.row, end: Date.parse(entry.effective.endedAt) }))
        .filter((entry) => entry.end <= start)
      const earlier = earlierKept.length
        ? earlierKept
        : deletedSources.filter((entry) => entry.end <= start)
      const latestEnd = Math.max(...earlier.map((entry) => entry.end))
      const candidates = linked.length
        ? linked.map((entry) => entry.row)
        : earlier.filter((entry) => entry.end === latestEnd).map((entry) => entry.row)
      const sourceId = choicesHere?.get(afterIndex)
      const source =
        sourceId === undefined ? undefined : candidates.find((row) => row.id === sourceId)
      if (sourceId !== undefined && !source) throw invalidChoice()
      const inheritedFields =
        kind === 'adopt'
          ? metadataFields.filter((field) => field !== 'description' && field !== 'billable')
          : metadataFields
      const conflictingFields = inheritedFields.filter((field) =>
        candidates.some((row) => row[field] !== candidates[0][field])
      )
      if (conflictingFields.length && !source)
        requiredChoices.push({
          afterIndex,
          candidateSessionIds: candidates.map((row) => row.id),
          conflictingFields
        })
      const from = source ?? (candidates.length ? candidates[0] : null)
      const metadata = from
        ? (Object.fromEntries(
            metadataFields.map((field) => [field, from[field]])
          ) as SessionMappingMetadata)
        : null
      if (kind === 'adopt' && metadata) {
        metadata.description = null
        metadata.billable = 1
      }

      const oneToOne = kind === 'continue' || kind === 'policy'
      const only = oneToOne ? linked[0] : null
      const preservedTimeFields = only ? only.preserved : []
      const effective = {
        startedAt: interval.startedAt,
        endedAt: interval.endedAt,
        durationMinutes: interval.durationMinutes
      }
      for (const field of preservedTimeFields)
        if (field === 'durationMinutes') effective[field] = only!.row[field]
        else effective[field] = only!.row[field]
      if (!validTimes(effective)) held.add('invalid-preserved-time')
      // Billed rows keep their id only for a true append under the same policy or
      // unchanged measurements; frozen billed ranges protect the earlier usage.
      const appended =
        kind === 'continue' &&
        !!only &&
        first(interval) === first(only.effective) &&
        interval.startedAt === only.effective.startedAt &&
        Date.parse(interval.endedAt) >= Date.parse(only.effective.endedAt)
      const keepSessionId =
        only &&
        !trimmed.has(predecessors.indexOf(only)) &&
        (!only.billed ||
          appended ||
          (sameTimes(interval, only.effective) &&
            sameCounts(interval, interval.modelUsage, only.effective)))
          ? only.row.id
          : null
      const hash = coverageHash(provider, conversationId, interval.coverage)
      return {
        afterIndex,
        kind,
        interval,
        coverageHash: hash,
        keepSessionId,
        predecessorSessionIds: linked.map((entry) => entry.row.id),
        predecessorMappingIds: linked.map((entry) => entry.mapping.id),
        predecessorRevisionIds: linked.map((entry) => entry.mapping.revisionId ?? entry.mapping.id),
        sourceSessionId: from && (source || candidates.length === 1) ? from.id : null,
        metadata,
        conflictingFields,
        preservedTimeFields,
        timeOverrides: Object.fromEntries(
          timeFields.map((field) => [field, preservedTimeFields.includes(field) ? 1 : 0])
        ) as Record<TimeField, 0 | 1>,
        effective,
        policyChanged: linked.some((entry) => entry.mapping.policyJson !== candidatePolicy),
        intervalUnchanged:
          linked.length === 1 &&
          sameCanonicalInterval(JSON.parse(linked[0].mapping.intervalJson) as Interval, interval),
        mappingId:
          keepSessionId !== null
            ? linked[0].mapping.id
            : derivedUuid('session-activity-mapping:v1', decisionId, hash),
        revisionId: derivedUuid('session-mapping-revision:v1', decisionId, hash)
      }
    })
    if (requiredChoices.length) held.add('metadata-choice-required')
    if (held.size) return result(requiredChoices)
    const kept = new Set(successors.map((plan) => plan.keepSessionId))
    const applicable: SessionMappingConversationPlan = {
      provider,
      conversationId,
      status: 'applicable',
      heldReasons: [],
      requiredChoices: [],
      activeSessionIds: active.map((row) => row.id),
      retiredSessionIds: predecessors.map((entry) => entry.row.id).filter((id) => !kept.has(id)),
      successors,
      ...(operations
        ? {
            suppressed: operations.suppressed.after.map(({ sessionIds, startedAt, endedAt }) => ({
              sessionIds,
              startedAt,
              endedAt
            }))
          }
        : {})
    }
    return applicable
  })

  if (acknowledgedReductions.some((key) => !coverageReductions.some((row) => row.key === key)))
    throw new AppError(
      'INVALID_COVERAGE_ACKNOWLEDGMENT',
      'Coverage changed; review the proposed reductions again'
    )
  const plan = {
    version: 1 as const,
    scope: 'session-mapping-application-plan' as const,
    decisionId,
    previewFingerprint: preview.fingerprint,
    workspaceId: history.workspaceId,
    baseRevisionId: history.baseRevisionId,
    candidatePolicy: history.candidatePolicy,
    choices: selected,
    coverageReductions,
    acknowledgedReductions: [...acknowledgedReductions].sort(),
    conversations,
    // Auto rows outside the captured ledger stay counted as saved; they are never planned.
    retainedWithoutActivity: history.comparisons
      .filter(
        (row) =>
          row.disposition === 'active' &&
          row.status === 'review-required' &&
          (row.reason === 'missing-conversation-id' || row.reason === 'missing-ledger-activity')
      )
      .map((row) => row.sessionId)
  }
  const hash = createHash('sha256').update(JSON.stringify(plan)).digest('hex')
  return { ...plan, fingerprint: `session-mapping-plan:v1:${hash}` }
}
