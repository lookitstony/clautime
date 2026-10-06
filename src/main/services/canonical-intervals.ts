import type { SessionModelUsage } from '../../shared/types/session'
import {
  retainsCanonicalEvent,
  type CanonicalConversation,
  type CanonicalEventReference
} from './canonical-activity'
import { readCanonicalCoverageUsage, type CodexUsageReference } from './canonical-codex'
import { detectSessionsWithPolicyTrace } from './session-detector'

type Resolved = Extract<CanonicalConversation, { status: 'resolved' }>
type Interval = ReturnType<typeof calculateCanonicalIntervals>[number]

export interface CanonicalIntervalCoverage {
  /** 1: messages and continuity only. 2: also every usage checkpoint counted for its messages. */
  version: 1 | 2
  messages: CanonicalEventReference[]
  continuity: Array<{
    from: CanonicalEventReference
    to: CanonicalEventReference
    startedAt: string
    endedAt: string
    progress: CanonicalEventReference[]
  }>
  /** Required (possibly empty) for version 2; absent for version 1. */
  usage?: CodexUsageReference[]
}

/** Property order is not evidence; every counter and ownership field is. */
export function canonicalUsageKey(entry: CodexUsageReference): string {
  return JSON.stringify([
    entry.checkpointId,
    entry.observationId,
    entry.messageEventId,
    entry.timestamp,
    entry.model,
    Object.entries(entry.delta).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    entry.usage.inputTokens,
    entry.usage.outputTokens,
    entry.usage.cacheCreationInputTokens,
    entry.usage.cacheReadInputTokens
  ])
}

/** Compatible observations can grow without changing a measured interval. */
export function sameCanonicalInterval(
  previous: ReturnType<typeof calculateCanonicalIntervals>[number],
  current: ReturnType<typeof calculateCanonicalIntervals>[number]
): boolean {
  const refs = (coverage: CanonicalIntervalCoverage) => [
    ...coverage.messages,
    ...coverage.continuity.flatMap((edge) => [edge.from, edge.to, ...edge.progress])
  ]
  const before = refs(previous.coverage)
  const after = refs(current.coverage)
  if (
    before.length !== after.length ||
    before.some((event, index) => !retainsCanonicalEvent(event, after[index]))
  )
    return false
  const ref = (event: CanonicalEventReference) => [event.eventId, event.kind, event.timestamp]
  const comparable = (interval: typeof previous) => ({
    startedAt: interval.startedAt,
    endedAt: interval.endedAt,
    durationMinutes: interval.durationMinutes,
    promptCount: interval.promptCount,
    inputTokens: interval.inputTokens,
    outputTokens: interval.outputTokens,
    modelUsage: interval.modelUsage,
    coverage: {
      version: interval.coverage.version,
      messages: interval.coverage.messages.map(ref),
      continuity: interval.coverage.continuity.map((edge) => [
        ref(edge.from),
        ref(edge.to),
        edge.startedAt,
        edge.endedAt,
        edge.progress.map(ref)
      ]),
      usage: interval.coverage.usage?.map(canonicalUsageKey)
    }
  })
  return JSON.stringify(comparable(previous)) === JSON.stringify(comparable(current))
}

/** Only already-resolved canonical conversations can supply these references. */
export function calculateCanonicalIntervals(
  conversation: Extract<CanonicalConversation, { status: 'resolved' }>,
  policy: unknown
) {
  const events = new Map(conversation.events.map((event) => [event.eventId, event]))
  const progress = conversation.events
    .filter((event) => event.kind === 'progress')
    .sort((a, b) => {
      const left = a.timestamp + a.eventId
      const right = b.timestamp + b.eventId
      return left < right ? -1 : left > right ? 1 : 0
    })
  const message = (id: string | null): CanonicalEventReference => {
    const event = id === null ? undefined : events.get(id)
    if (!event || event.kind !== 'message') throw new Error('Missing canonical message reference')
    return event
  }
  return detectSessionsWithPolicyTrace(conversation.recording, policy).map((trace) => {
    const messages = trace.messageIds.map(message)
    const continuity = trace.continuity.map((edge) => ({
      from: message(edge.fromMessageId),
      to: message(edge.toMessageId),
      startedAt: edge.startedAt,
      endedAt: edge.endedAt,
      // These are the retained progress records in this portion of the gap,
      // not extra prompts/tokens or a claim that each determined the split.
      progress: progress.filter(
        (event) =>
          event.timestamp > message(edge.fromMessageId).timestamp &&
          event.timestamp < message(edge.toMessageId).timestamp &&
          event.timestamp >= edge.startedAt &&
          event.timestamp < edge.endedAt
      )
    }))
    // Usage owned by this interval's messages is exactly what its token counts include.
    // Unowned usage (no assistant yet) is never attached to an interval.
    const members = new Set(messages.map((event) => event.eventId))
    const coverage: CanonicalIntervalCoverage = conversation.usage
      ? {
          version: 2,
          messages,
          continuity,
          usage: conversation.usage.filter(
            (entry) => entry.messageEventId !== null && members.has(entry.messageEventId)
          )
        }
      : { version: 1, messages, continuity }
    const session = trace.session
    return {
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationMinutes: session.durationMinutes,
      promptCount: session.promptCount,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      modelUsage: session.modelUsage,
      coverage
    }
  })
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
function event(value: unknown, kind: CanonicalEventReference['kind']): boolean {
  return (
    object(value) &&
    typeof value.eventId === 'string' &&
    !!value.eventId &&
    typeof value.observationId === 'string' &&
    !!value.observationId &&
    value.kind === kind &&
    timestamp(value.timestamp) &&
    (value.observationIds === undefined ||
      (Array.isArray(value.observationIds) &&
        value.observationIds.every((id) => typeof id === 'string' && id.length > 0) &&
        new Set(value.observationIds).size === value.observationIds.length &&
        value.observationIds.includes(value.observationId)))
  )
}
/** Every event reference a coverage counts or measures a gap with. */
export function canonicalCoverageReferences(
  coverage: CanonicalIntervalCoverage
): CanonicalEventReference[] {
  return [
    ...coverage.messages,
    ...coverage.continuity.flatMap((edge) => [edge.from, edge.to, ...edge.progress])
  ]
}

/**
 * Validate a historical snapshot before using its anchors; never repair malformed evidence.
 * A fragment between explicit split cuts may hold no message, but only when its measured
 * continuity spans it exactly and it counts nothing; empty coverage is never valid.
 */
export function readCanonicalIntervalSnapshot(json: string, provider: string): Interval | null {
  try {
    const value: unknown = JSON.parse(json)
    if (
      !object(value) ||
      !timestamp(value.startedAt) ||
      !timestamp(value.endedAt) ||
      value.endedAt < value.startedAt ||
      !['durationMinutes', 'promptCount', 'inputTokens', 'outputTokens'].every((key) =>
        count(value[key])
      ) ||
      !Array.isArray(value.modelUsage) ||
      !value.modelUsage.every(
        (row) =>
          object(row) &&
          typeof row.model === 'string' &&
          ['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens'].every(
            (key) => count(row[key])
          )
      ) ||
      !object(value.coverage) ||
      value.coverage.version !== (provider === 'codex' ? 2 : 1) ||
      !Array.isArray(value.coverage.messages) ||
      !value.coverage.messages.every((item) => event(item, 'message')) ||
      !Array.isArray(value.coverage.continuity) ||
      !value.coverage.continuity.every(
        (edge) =>
          object(edge) &&
          event(edge.from, 'message') &&
          event(edge.to, 'message') &&
          timestamp(edge.startedAt) &&
          timestamp(edge.endedAt) &&
          edge.startedAt < edge.endedAt &&
          Array.isArray(edge.progress) &&
          edge.progress.every((item) => event(item, 'progress'))
      ) ||
      (!value.coverage.messages.length && !value.coverage.continuity.length)
    )
      return null
    const interval = value as unknown as Interval
    const { coverage } = interval
    if (coverage.version === 1) {
      if (
        'usage' in coverage ||
        canonicalCoverageReferences(coverage).some((item) => 'observationIds' in item)
      )
        return null
    } else {
      const usage = readCanonicalCoverageUsage(coverage.usage)
      if (
        !usage ||
        usage.some(
          (item) =>
            item.messageEventId === null ||
            !coverage.messages.some((event) => event.eventId === item.messageEventId)
        )
      )
        return null
      const byModel = new Map<string, SessionModelUsage>()
      for (const entry of usage) {
        const model = entry.model ?? 'unknown'
        const row = byModel.get(model) ?? {
          model,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0
        }
        row.inputTokens += entry.usage.inputTokens
        row.outputTokens += entry.usage.outputTokens
        row.cacheCreationInputTokens += entry.usage.cacheCreationInputTokens
        row.cacheReadInputTokens += entry.usage.cacheReadInputTokens
        byModel.set(model, row)
      }
      const rows = [...byModel.values()]
      if (
        rows.reduce((total, row) => total + row.inputTokens, 0) !== interval.inputTokens ||
        rows.reduce((total, row) => total + row.outputTokens, 0) !== interval.outputTokens ||
        interval.modelUsage.some(
          (row) =>
            !byModel.has(row.model) &&
            (row.inputTokens ||
              row.outputTokens ||
              row.cacheCreationInputTokens ||
              row.cacheReadInputTokens)
        ) ||
        new Set(interval.modelUsage.map((row) => row.model)).size !== interval.modelUsage.length ||
        rows.some((row) => {
          const actual = interval.modelUsage.find((item) => item.model === row.model)
          return (
            !actual ||
            [
              'inputTokens',
              'outputTokens',
              'cacheCreationInputTokens',
              'cacheReadInputTokens'
            ].some((key) => actual[key as keyof typeof actual] !== row[key as keyof typeof row])
          )
        })
      )
        return null
    }
    if (
      new Set(coverage.messages.map((item) => item.eventId)).size !== coverage.messages.length ||
      coverage.messages.some(
        (item) => item.timestamp < interval.startedAt || item.timestamp > interval.endedAt
      ) ||
      coverage.continuity.some(
        (edge) =>
          edge.from.eventId === edge.to.eventId ||
          edge.startedAt < interval.startedAt ||
          edge.endedAt > interval.endedAt ||
          edge.startedAt < edge.from.timestamp ||
          edge.endedAt > edge.to.timestamp ||
          edge.progress.some(
            (item) =>
              item.timestamp <= edge.from.timestamp ||
              item.timestamp >= edge.to.timestamp ||
              item.timestamp < edge.startedAt ||
              item.timestamp >= edge.endedAt
          )
      )
    )
      return null
    if (!coverage.messages.length) {
      const starts = coverage.continuity.map((edge) => edge.startedAt).sort()
      const ends = coverage.continuity.map((edge) => edge.endedAt).sort()
      if (
        interval.promptCount ||
        interval.inputTokens ||
        interval.outputTokens ||
        interval.modelUsage.length ||
        (coverage.usage ?? []).length ||
        starts[0] !== interval.startedAt ||
        ends[ends.length - 1] !== interval.endedAt
      )
        return null
    }
    return interval
  } catch {
    return null
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

/**
 * Exact ownership partition of one calculated interval at explicit UTC cuts inside it.
 * A message at a cut belongs to the later part; gaps are clipped so no span counts twice;
 * Codex checkpoint usage stays with its owning message even when recorded after the cut.
 * Counts come from the canonical message facts, never from a time proportion. Minutes are
 * offsets from the calculated interval's own start, so any sequence of cuts over the same
 * interval telescopes to its measured duration.
 */
export function partitionCanonicalInterval(
  conversation: Resolved,
  interval: Interval,
  cuts: readonly string[]
): Interval[] {
  const start = Date.parse(interval.startedAt)
  const end = Date.parse(interval.endedAt)
  const inside = [...new Set(cuts.map((cut) => Date.parse(cut)))]
    .filter((cut) => cut > start && cut < end)
    .sort((a, b) => a - b)
  if (!inside.length) return [interval]
  const facts = new Map(conversation.recording.messages.map((message) => [message.uuid, message]))
  const bounds = [start, ...inside, end]
  const offset = (ms: number) => Math.round((ms - start) / 60_000)
  return bounds.slice(0, -1).map((from, index): Interval => {
    const last = index === bounds.length - 2
    const to = bounds[index + 1]
    const messages = interval.coverage.messages.filter((item) => {
      const at = Date.parse(item.timestamp)
      return at >= from && (last ? at <= to : at < to)
    })
    const continuity = interval.coverage.continuity.flatMap((edge) => {
      const s = Math.max(Date.parse(edge.startedAt), from)
      const t = Math.min(Date.parse(edge.endedAt), to)
      if (t <= s) return []
      return [
        {
          from: edge.from,
          to: edge.to,
          startedAt: iso(s),
          endedAt: iso(t),
          progress: edge.progress.filter((item) => {
            const at = Date.parse(item.timestamp)
            return at >= s && at < t
          })
        }
      ]
    })
    let promptCount = 0
    let inputTokens = 0
    let outputTokens = 0
    const byModel = new Map<string, SessionModelUsage>()
    for (const item of messages) {
      const fact = facts.get(item.eventId)
      if (!fact) throw new Error('Missing canonical message fact')
      if (fact.type === 'user' && !fact.isToolResult) promptCount++
      if (!fact.usage) continue
      inputTokens += fact.usage.inputTokens
      outputTokens += fact.usage.outputTokens
      const model = fact.model ?? 'unknown'
      const row = byModel.get(model) ?? {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      }
      row.inputTokens += fact.usage.inputTokens
      row.outputTokens += fact.usage.outputTokens
      row.cacheCreationInputTokens += fact.usage.cacheCreationInputTokens
      row.cacheReadInputTokens += fact.usage.cacheReadInputTokens
      byModel.set(model, row)
    }
    const members = new Set(messages.map((item) => item.eventId))
    const coverage: CanonicalIntervalCoverage =
      interval.coverage.version === 2
        ? {
            version: 2,
            messages,
            continuity,
            usage: (interval.coverage.usage ?? []).filter(
              (entry) => entry.messageEventId !== null && members.has(entry.messageEventId)
            )
          }
        : { version: 1, messages, continuity }
    return {
      startedAt: iso(from),
      endedAt: iso(to),
      durationMinutes: (last ? interval.durationMinutes : offset(to)) - (index ? offset(from) : 0),
      promptCount,
      inputTokens,
      outputTokens,
      modelUsage: [...byModel.values()],
      coverage
    }
  })
}

/**
 * Coverage removed from active history by an explicit deletion: a proven deletion of a local
 * adopted row (sessionId), a portable session-deletion fact (operationId, its sync change ID),
 * or both. At least one owner is required; a portable fact never invents a local row.
 */
export interface CanonicalCoverageMask {
  sessionId?: number
  operationId?: string
  coverage: CanonicalIntervalCoverage
}

/** An operation that holds its conversation; names the local row and/or the portable fact. */
export interface CanonicalOperationHold {
  sessionId?: number
  operationId?: string
  reason: string
}

/** Reviewed explicit history operations of one conversation. */
export interface CanonicalHistoryConstraints {
  /** Explicit split instants (normalized UTC). No calculated interval may cross one. */
  cuts: string[]
  /** Portable split facts behind `cuts` (a cut may also, or only, be a local proven split). */
  cutOperations?: Array<{ operationId: string; splitAt: string }>
  masks: CanonicalCoverageMask[]
  /** Operations whose stored evidence cannot be read or no longer matches the ledger. */
  invalid: CanonicalOperationHold[]
}

export interface ConstrainedFragment {
  /** Local deleted rows whose masks own part of this fragment. */
  sessionIds: number[]
  /** Portable deletion facts whose masks own part of this fragment. */
  operationIds: string[]
  interval: Interval
}

// Internal owner keys keep local numeric rows and portable facts distinct.
const localOwner = (sessionId: number) => `local:${sessionId}`
const portableOwner = (operationId: string) => `op:${operationId}`
function maskOwners(mask: CanonicalCoverageMask): string[] {
  const owners = [
    ...(mask.sessionId !== undefined ? [localOwner(mask.sessionId)] : []),
    ...(mask.operationId !== undefined ? [portableOwner(mask.operationId)] : [])
  ]
  if (!owners.length) throw new Error('A deletion mask needs a local session or portable operation')
  return owners
}
function maskHold(mask: CanonicalCoverageMask, reason: string): CanonicalOperationHold {
  return {
    ...(mask.sessionId !== undefined ? { sessionId: mask.sessionId } : {}),
    ...(mask.operationId !== undefined ? { operationId: mask.operationId } : {}),
    reason
  }
}

/**
 * Apply explicit cuts, then deletion masks. A part wholly inside deleted coverage stays
 * suppressed under any policy; a part disjoint from it counts. A part that mixes deleted
 * coverage with anything else (continued work, a merged gap, new evidence) is a conflict:
 * it is neither counted nor suppressed, and callers must hold the conversation.
 * A portable deletion can arrive before its activity facts: it is held as
 * missing-deleted-evidence until every referenced fact is present, then suppresses.
 */
export function constrainCanonicalIntervals(
  conversation: Resolved,
  intervals: Interval[],
  constraints: CanonicalHistoryConstraints
) {
  const invalid = [...constraints.invalid]
  const events = new Map(conversation.events.map((item) => [item.eventId, item]))
  const usage = new Map((conversation.usage ?? []).map((entry) => [entry.checkpointId, entry]))
  const masked = {
    events: new Map<string, Set<string>>(),
    usage: new Map<string, Set<string>>(),
    spans: [] as Array<[number, number, string[]]>
  }
  const claimed = (map: Map<string, Set<string>>, id: string, owners: string[]) => {
    const set = map.get(id) ?? new Set<string>()
    for (const owner of owners) set.add(owner)
    map.set(id, set)
  }
  for (const mask of constraints.masks) {
    const owners = maskOwners(mask)
    let missing = false
    let changed = false
    for (const item of canonicalCoverageReferences(mask.coverage)) {
      const current = events.get(item.eventId)
      if (!current) missing = true
      else if (!retainsCanonicalEvent(item, current)) changed = true
    }
    for (const entry of mask.coverage.usage ?? []) {
      const current = usage.get(entry.checkpointId)
      if (!current) missing = true
      else if (canonicalUsageKey(current) !== canonicalUsageKey(entry)) changed = true
    }
    // A local proven deletion keeps its original strict reason; only portable facts may wait.
    if (changed || (missing && mask.sessionId !== undefined))
      invalid.push(maskHold(mask, 'changed-deleted-evidence'))
    else if (missing) invalid.push(maskHold(mask, 'missing-deleted-evidence'))
    for (const item of [
      ...mask.coverage.messages,
      ...mask.coverage.continuity.flatMap((edge) => edge.progress)
    ])
      claimed(masked.events, item.eventId, owners)
    for (const entry of mask.coverage.usage ?? []) claimed(masked.usage, entry.checkpointId, owners)
    for (const edge of mask.coverage.continuity)
      masked.spans.push([Date.parse(edge.startedAt), Date.parse(edge.endedAt), owners])
  }
  masked.spans.sort((a, b) => a[0] - b[0])
  const result = {
    intervals: [] as Interval[],
    suppressed: [] as ConstrainedFragment[],
    conflicts: [] as ConstrainedFragment[],
    invalid
  }
  for (const interval of intervals)
    for (const fragment of partitionCanonicalInterval(conversation, interval, constraints.cuts)) {
      const owners = new Set<string>()
      let uncovered = false
      const claim = (found: Set<string> | undefined) => {
        if (!found) uncovered = true
        else for (const owner of found) owners.add(owner)
      }
      for (const item of fragment.coverage.messages) claim(masked.events.get(item.eventId))
      for (const edge of fragment.coverage.continuity) {
        for (const item of edge.progress) claim(masked.events.get(item.eventId))
        const end = Date.parse(edge.endedAt)
        let covered = Date.parse(edge.startedAt)
        for (const [start, stop, spanOwners] of masked.spans) {
          if (stop <= Date.parse(edge.startedAt) || start >= end) continue
          for (const owner of spanOwners) owners.add(owner)
          if (start <= covered) covered = Math.max(covered, stop)
        }
        if (covered < end) uncovered = true
      }
      for (const entry of fragment.coverage.usage ?? []) claim(masked.usage.get(entry.checkpointId))
      if (!owners.size) result.intervals.push(fragment)
      else {
        const keys = [...owners]
        ;(uncovered ? result.conflicts : result.suppressed).push({
          sessionIds: keys
            .filter((key) => key.startsWith('local:'))
            .map((key) => Number(key.slice('local:'.length)))
            .sort((a, b) => a - b),
          operationIds: keys
            .filter((key) => key.startsWith('op:'))
            .map((key) => key.slice('op:'.length))
            .sort(),
          interval: fragment
        })
      }
    }
  return result
}

/** Relationships between calculations, never proof of a saved row's event ownership. */
export function relateCanonicalIntervals(
  before: Array<{ coverage: CanonicalIntervalCoverage }>,
  after: Array<{ coverage: CanonicalIntervalCoverage }>
) {
  return after.map((candidate, afterIndex) => ({
    afterIndex,
    predecessors: before.flatMap((previous, beforeIndex) => {
      const messageIds = new Set(previous.coverage.messages.map((event) => event.eventId))
      const sharedMessageEventIds = candidate.coverage.messages
        .filter((event) => messageIds.has(event.eventId))
        .map((event) => event.eventId)
      const sharedContinuity = candidate.coverage.continuity.flatMap((edge) =>
        previous.coverage.continuity.flatMap((earlier) => {
          if (edge.from.eventId !== earlier.from.eventId || edge.to.eventId !== earlier.to.eventId)
            return []
          const start = Math.max(Date.parse(edge.startedAt), Date.parse(earlier.startedAt))
          const end = Math.min(Date.parse(edge.endedAt), Date.parse(earlier.endedAt))
          return end > start
            ? [
                {
                  fromEventId: edge.from.eventId,
                  toEventId: edge.to.eventId,
                  startedAt: new Date(start).toISOString(),
                  endedAt: new Date(end).toISOString()
                }
              ]
            : []
        })
      )
      return sharedMessageEventIds.length || sharedContinuity.length
        ? [{ beforeIndex, sharedMessageEventIds, sharedContinuity }]
        : []
    })
  }))
}
