import { and, eq, inArray } from 'drizzle-orm'
import type { getDb } from '../db'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import type { ParsedMessage, ParsedSessionData, TokenUsage } from '../parsers/types'
import { requireExplicitTimestamp } from '../../shared/tracking-policy'
import type { CanonicalEventReference } from './canonical-activity'
import type { CanonicalIntervalCoverage } from './canonical-intervals'
import { readCodexCheckpointDeltas, type CodexCheckpointDelta } from './codex-checkpoint-deltas'

type ResolvedDelta = Extract<CodexCheckpointDelta, { status: 'resolved' }>
type CheckpointReason = Extract<CodexCheckpointDelta, { status: 'unresolved' }>['reason']

export type CodexUnresolvedReason =
  | 'unsupported-version'
  | 'missing-observation'
  | 'conflicting-observations'
  | 'invalid-observation'
  | 'unknown-ancestry'
  | 'missing-predecessor'
  | 'ambiguous-roots'
  | 'cyclic-ancestry'
  | 'branching-activity'
  | 'nonmonotonic-time'
  | 'no-messages'
  | 'inconsistent-snapshot'
  | 'unresolved-checkpoint'
  | 'branching-checkpoints'
  | 'misordered-checkpoint'
  | 'invalid-usage-delta'
  | 'mixed-model-usage'
  | 'model-mismatch'
  | 'usage-mismatch'

export interface CodexEventReference extends CanonicalEventReference {
  /** Every compatible observation of this fact. observationId is the least ID, not a winner. */
  observationIds: string[]
}

/** One nonzero checkpoint delta and the single observation it was derived from. */
export interface CodexUsageReference {
  checkpointId: string
  observationId: string
  /** Assistant message holding the usage; null while no assistant has been recorded. */
  messageEventId: string | null
  timestamp: string
  model: string | null
  /** Raw counter deltas, including counters that interval totals do not use. */
  delta: Record<string, number>
  usage: TokenUsage
}

export type CodexCheckpointHold = { checkpointId: string; reason: CheckpointReason }

export type CanonicalCodexConversation = {
  provider: 'codex'
  conversationId: string
  eventIds: string[]
  observationIds: string[]
} & (
  | {
      status: 'resolved'
      recording: ParsedSessionData
      events: CodexEventReference[]
      usage: CodexUsageReference[]
    }
  | {
      status: 'unresolved'
      reason: CodexUnresolvedReason
      checkpoint?: CodexCheckpointHold
    }
)

type Observation = typeof activityObservations.$inferSelect
type Row = { identity: typeof activityIdentities.$inferSelect; observation: Observation | null }
type Fact = {
  parent: string | null
  timestamp: string
  kind: string
  message: Pick<ParsedMessage, 'type' | 'isToolResult' | 'hasToolUse' | 'toolNames'> | null
  model: string | null
  usage: TokenUsage | null
}
type Node = Omit<Fact, 'usage'> & {
  id: string
  observationIds: string[]
  usages: Array<TokenUsage | null>
}
/** Anchored progress: parent is the activity head it was written after, never a new head. */
type Leaf = { id: string; parent: string | null; timestamp: string; observationIds: string[] }

// Item types the Codex parser always projects as messages, never as bare activity.
const messageItemKinds = [
  'function_call',
  'local_shell_call',
  'custom_tool_call',
  'web_search_call',
  'function_call_output',
  'custom_tool_call_output'
]
// Other-role messages and compaction markers carry ancestry, but the parser
// counts them as neither messages nor progress.
const ancestryOnlyKinds = ['message', 'compacted']
const messageKeys = [
  'type',
  'timestamp',
  'parentEventId',
  'model',
  'usage',
  'isToolResult',
  'hasToolUse',
  'toolNames'
]
const progressKeys = ['kind', 'progressType', 'timestamp', 'parentEventId']
const usageKeys = [
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens'
] as const

const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0
})
function addUsage(total: TokenUsage, usage: TokenUsage): TokenUsage {
  for (const key of usageKeys) total[key] += usage[key]
  return total
}
const usageKey = (usage: TokenUsage): string => JSON.stringify(usageKeys.map((key) => usage[key]))

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function reference(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0)
}
function instant(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    requireExplicitTimestamp(value)
  } catch {
    return null
  }
  return new Date(value).toISOString()
}
function tokens(value: unknown): TokenUsage | null | undefined {
  if (value === null) return null
  if (!object(value) || Object.keys(value).length !== usageKeys.length) return undefined
  if (!usageKeys.every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0))
    return undefined
  // The Codex parser never records cache writes.
  return value.cacheCreationInputTokens === 0 ? (value as unknown as TokenUsage) : undefined
}

function decode(kind: Observation['kind'], value: Record<string, unknown>): Fact | null {
  const timestamp = instant(value.timestamp)
  if (!timestamp || !reference(value.parentEventId)) return null
  const parent = value.parentEventId as string | null
  if (kind === 'activity') {
    const itemKind = typeof value.kind === 'string' ? value.kind : ''
    if (
      !itemKind.trim() ||
      messageItemKinds.includes(itemKind) ||
      Object.keys(value).some((key) => !['kind', 'timestamp', 'parentEventId'].includes(key))
    )
      return null
    return { parent, timestamp, kind: itemKind, message: null, model: null, usage: null }
  }
  const usage = tokens(value.usage)
  if (
    kind !== 'message' ||
    usage === undefined ||
    Object.keys(value).some((key) => !messageKeys.includes(key)) ||
    !['user', 'system', 'assistant'].includes(value.type as string) ||
    typeof value.isToolResult !== 'boolean' ||
    typeof value.hasToolUse !== 'boolean' ||
    !(value.model === null || (typeof value.model === 'string' && value.model.trim())) ||
    !Array.isArray(value.toolNames) ||
    !value.toolNames.every((name) => typeof name === 'string') ||
    value.toolNames.length !== (value.hasToolUse ? 1 : 0)
  )
    return null
  // The parser flags tool output only on user records and attaches models,
  // tool calls and usage only to assistant records.
  if (
    value.type === 'assistant'
      ? value.isToolResult
      : value.hasToolUse ||
        value.model !== null ||
        usage !== null ||
        (value.type === 'system' && value.isToolResult)
  )
    return null
  return {
    parent,
    timestamp,
    kind: 'message',
    message: {
      type: value.type as string,
      isToolResult: value.isToolResult,
      hasToolUse: value.hasToolUse,
      toolNames: value.toolNames as string[]
    },
    model: value.model as string | null,
    usage
  }
}

/** A progress leaf (basis 'progress'). Its recorded event type is compared, not interpreted. */
function decodeProgress(kind: Observation['kind'], value: Record<string, unknown>): Fact | null {
  const timestamp = instant(value.timestamp)
  if (
    kind !== 'activity' ||
    !timestamp ||
    !reference(value.parentEventId) ||
    value.kind !== 'progress' ||
    typeof value.progressType !== 'string' ||
    !value.progressType.trim() ||
    Object.keys(value).some((key) => !progressKeys.includes(key))
  )
    return null
  return {
    parent: value.parentEventId as string | null,
    timestamp,
    kind: value.progressType as string,
    message: null,
    model: null,
    usage: null
  }
}

/**
 * The delta reader runs its own statement. A delta is used only if this read's payloads
 * for the checkpoint and its predecessor reproduce every field and every counter delta.
 */
function sameCheckpoint(
  value: Record<string, unknown>,
  parent: Record<string, unknown> | null,
  delta: ResolvedDelta
): boolean {
  if (
    value.previousCheckpointId !== delta.previousCheckpointId ||
    value.activityEventId !== delta.activityEventId ||
    value.timestamp !== delta.timestamp ||
    value.model !== delta.model
  )
    return false
  const fields = Object.keys(delta.delta)
  const totals = value.totals
  const previous = parent === null ? {} : parent.totals
  if (
    !object(totals) ||
    !object(previous) ||
    Object.keys(totals).length !== fields.length ||
    (parent !== null && Object.keys(previous).length !== fields.length)
  )
    return false
  return fields.every((field) => {
    const before = parent === null ? 0 : previous[field]
    const after = totals[field]
    return (
      typeof after === 'number' &&
      typeof before === 'number' &&
      Number.isSafeInteger(after) &&
      Number.isSafeInteger(before) &&
      after - before === delta.delta[field]
    )
  })
}

/**
 * How nonzero checkpoint usage is attributed to assistant messages. 1 reproduces the parser
 * (and every interval and coverage recorded so far); 2 attributes usage recorded after a new
 * prompt to that prompt's reply. Event and checkpoint IDs are identical under both.
 */
export type CodexCheckpointOwnership = 1 | 2

function project(
  conversationId: string,
  group: Row[],
  deltas: CodexCheckpointDelta[],
  ownership: CodexCheckpointOwnership = 1
): CanonicalCodexConversation {
  const base = {
    provider: 'codex' as const,
    conversationId,
    eventIds: [...new Set(group.map((row) => row.identity.eventId))],
    observationIds: group.flatMap((row) => (row.observation ? [row.observation.id] : []))
  }
  const unresolved = (
    reason: CodexUnresolvedReason,
    checkpoint?: { checkpointId: string; reason: CheckpointReason }
  ): CanonicalCodexConversation => ({
    ...base,
    status: 'unresolved',
    reason,
    ...(checkpoint ? { checkpoint } : {})
  })
  if (
    group.some(
      ({ identity, observation }) =>
        identity.identityVersion !== 1 ||
        (observation !== null && observation.version !== 1) ||
        !['native', 'fingerprint', 'checkpoint', 'progress'].includes(identity.basis)
    )
  )
    return unresolved('unsupported-version')
  if (group.some((row) => !row.observation)) return unresolved('missing-observation')
  const byEvent = new Map<string, { basis: string; observations: Observation[] }>()
  for (const { identity, observation } of group) {
    const entry = byEvent.get(identity.eventId) ?? { basis: identity.basis, observations: [] }
    entry.observations.push(observation!)
    byEvent.set(identity.eventId, entry)
  }

  const nodes = new Map<string, Node>()
  const leaves: Leaf[] = []
  const checkpointIds: string[] = []
  for (const [id, { basis, observations }] of byEvent) {
    if (basis === 'checkpoint') {
      // Multiplicity and payloads are judged by the checkpoint delta reader.
      if (observations.some((observation) => observation.kind !== 'checkpoint'))
        return unresolved('invalid-observation')
      checkpointIds.push(id)
      continue
    }
    if (new Set(observations.map((observation) => observation.kind)).size > 1)
      return unresolved('conflicting-observations')
    const facts: Fact[] = []
    for (const observation of observations) {
      let payload: unknown
      try {
        payload = JSON.parse(observation.payloadJson)
      } catch {
        return unresolved('invalid-observation')
      }
      if (object(payload) && !Object.hasOwn(payload, 'parentEventId'))
        return unresolved('unknown-ancestry')
      const fact = !object(payload)
        ? null
        : basis === 'progress'
          ? decodeProgress(observation.kind, payload)
          : decode(observation.kind, payload)
      if (!fact) return unresolved('invalid-observation')
      facts.push(fact)
    }
    // A growing or copied rollout re-observes messages with the parser's running
    // usage and late model fill-in. Those are re-derived from checkpoints below;
    // everything else must agree exactly.
    const models = new Set(facts.flatMap((fact) => (fact.model ? [fact.model] : [])))
    const immutable = new Set(
      facts.map((fact) => JSON.stringify([fact.parent, fact.timestamp, fact.kind, fact.message]))
    )
    if (immutable.size !== 1 || models.size > 1) return unresolved('conflicting-observations')
    const { parent, timestamp, kind, message } = facts[0]
    const observationIds = observations.map((observation) => observation.id).sort()
    if (basis === 'progress') {
      leaves.push({ id, parent, timestamp, observationIds })
      continue
    }
    nodes.set(id, {
      id,
      parent,
      timestamp,
      kind,
      message,
      model: [...models][0] ?? null,
      usages: facts.map((fact) => fact.usage),
      observationIds
    })
  }

  const roots: Node[] = []
  const children = new Map<string, Node[]>()
  for (const node of nodes.values()) {
    if (node.parent === null) {
      roots.push(node)
      continue
    }
    if (!nodes.has(node.parent)) return unresolved('missing-predecessor')
    const siblings = children.get(node.parent) ?? []
    siblings.push(node)
    children.set(node.parent, siblings)
  }
  if (roots.length > 1) return unresolved('ambiguous-roots')
  if (!roots.length) return unresolved(nodes.size ? 'cyclic-ancestry' : 'no-messages')
  // Every captured Codex item advances one head, so a second continuation is a fork.
  if ([...children.values()].some((siblings) => siblings.length > 1))
    return unresolved('branching-activity')
  const chain: Node[] = []
  for (let node: Node | undefined = roots[0]; node; node = children.get(node.id)?.[0])
    chain.push(node)
  if (chain.length !== nodes.size) return unresolved('cyclic-ancestry')
  if (chain.some((node, index) => index > 0 && node.timestamp < chain[index - 1].timestamp))
    return unresolved('nonmonotonic-time')
  if (!chain.some((node) => node.message)) return unresolved('no-messages')

  // The delta reader runs its own statement; only use deltas matching this snapshot.
  if (deltas.length !== checkpointIds.length) return unresolved('inconsistent-snapshot')
  const deltaById = new Map(deltas.map((delta) => [delta.checkpointId, delta]))
  // This read's single payload for a checkpoint of this conversation, else undefined.
  const payload = (id: string) => {
    const entry = byEvent.get(id)
    if (entry?.basis !== 'checkpoint' || entry.observations.length !== 1) return undefined
    try {
      const value: unknown = JSON.parse(entry.observations[0].payloadJson)
      return object(value) ? value : undefined
    } catch {
      return undefined
    }
  }
  const checkpoints: Array<{ delta: ResolvedDelta; observationId: string }> = []
  for (const id of checkpointIds.sort()) {
    const delta = deltaById.get(id)
    if (!delta) return unresolved('inconsistent-snapshot')
    if (delta.status === 'unresolved')
      return unresolved('unresolved-checkpoint', { checkpointId: id, reason: delta.reason })
    const own = payload(id)
    const parent = delta.previousCheckpointId === null ? null : payload(delta.previousCheckpointId)
    if (!own || parent === undefined || !sameCheckpoint(own, parent, delta))
      return unresolved('inconsistent-snapshot')
    checkpoints.push({ delta, observationId: byEvent.get(id)!.observations[0].id })
  }
  const following = new Map<string | null, (typeof checkpoints)[number]>()
  for (const checkpoint of checkpoints) {
    // Sibling deltas are each resolved against their shared predecessor; adding
    // both would count two alternative continuations of one counter.
    if (following.has(checkpoint.delta.previousCheckpointId))
      return unresolved('branching-checkpoints')
    following.set(checkpoint.delta.previousCheckpointId, checkpoint)
  }
  const ordered: typeof checkpoints = []
  for (let next = following.get(null); next; next = following.get(next.delta.checkpointId))
    ordered.push(next)
  if (ordered.length !== checkpoints.length) return unresolved('inconsistent-snapshot')

  const position = new Map(chain.map((node, index) => [node.id, index]))
  const assistants = chain.flatMap((node, index) =>
    node.message?.type === 'assistant' ? [index] : []
  )
  const usage: CodexUsageReference[] = []
  // The parser's (ownership 1) owner of each usage entry: captured message totals follow it.
  const parserOwners: Array<string | null> = []
  const checkpointEvents: CodexEventReference[] = []
  let previous = { position: -1, timestamp: '' }
  for (const { delta, observationId } of ordered) {
    const at = delta.activityEventId === null ? -1 : position.get(delta.activityEventId)
    if (at === undefined) return unresolved('missing-predecessor')
    const timestamp = instant(delta.timestamp)
    if (!timestamp) return unresolved('invalid-observation')
    if (at < previous.position) return unresolved('misordered-checkpoint')
    if (
      timestamp < previous.timestamp ||
      (at >= 0 && timestamp < chain[at].timestamp) ||
      (at + 1 < chain.length && timestamp > chain[at + 1].timestamp)
    )
      return unresolved('nonmonotonic-time')
    previous = { position: at, timestamp }
    checkpointEvents.push({
      eventId: delta.checkpointId,
      observationId,
      observationIds: [observationId],
      kind: 'progress',
      timestamp
    })
    const { input_tokens: input, cached_input_tokens: cached, output_tokens: output } = delta.delta
    // input_tokens includes cached input; a larger cached delta has no valid split.
    if (cached > input) return unresolved('invalid-usage-delta')
    if (!input && !cached && !output) continue
    // Ownership 1 is the parser's: the latest assistant record so far, else the next one.
    let owner: number | undefined
    for (const index of assistants) {
      if (index <= at) owner = index
      else {
        owner ??= index
        break
      }
    }
    parserOwners.push(owner === undefined ? null : chain[owner].id)
    // Ownership 2: a checkpoint written after a new user prompt (for example on resuming after
    // idle, before the reply) belongs to that prompt's reply, never to the earlier assistant.
    // Until the reply is recorded it stays unowned; no owner is invented.
    if (
      ownership === 2 &&
      owner !== undefined &&
      owner <= at &&
      chain
        .slice(owner + 1, at + 1)
        .some((node) => node.message?.type === 'user' && !node.message.isToolResult)
    )
      owner = assistants.find((index) => index > at)
    usage.push({
      checkpointId: delta.checkpointId,
      observationId,
      messageEventId: owner === undefined ? null : chain[owner].id,
      timestamp,
      model: delta.model,
      delta: delta.delta,
      usage: {
        inputTokens: input - cached,
        outputTokens: output,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: cached
      }
    })
  }

  // Progress leaves never extend the chain, so several on one head are not a fork. Like
  // checkpoints, each must fall between its anchor and the next recorded activity.
  const progressEvents: CodexEventReference[] = []
  for (const leaf of leaves) {
    const at = leaf.parent === null ? -1 : position.get(leaf.parent)
    if (at === undefined) return unresolved('missing-predecessor')
    if (
      (at >= 0 && leaf.timestamp < chain[at].timestamp) ||
      (at + 1 < chain.length && leaf.timestamp > chain[at + 1].timestamp)
    )
      return unresolved('nonmonotonic-time')
    progressEvents.push({
      eventId: leaf.id,
      observationId: leaf.observationIds[0],
      observationIds: leaf.observationIds,
      kind: 'progress',
      timestamp: leaf.timestamp
    })
  }
  // By instant (normalized, fixed width), then event ID; never by anchor.
  progressEvents.sort((a, b) => {
    const left = a.timestamp + a.eventId
    const right = b.timestamp + b.eventId
    return left < right ? -1 : left > right ? 1 : 0
  })

  const byOwner = (owners: Array<string | null>) => {
    const owned = new Map<string, CodexUsageReference[]>()
    usage.forEach((entry, index) => {
      const owner = owners[index]
      if (owner === null) return
      const refs = owned.get(owner) ?? []
      refs.push(entry)
      owned.set(owner, refs)
    })
    return owned
  }
  const owned = byOwner(usage.map((entry) => entry.messageEventId))
  const parserOwned = ownership === 1 ? owned : byOwner(parserOwners)
  const messages: ParsedMessage[] = []
  for (const node of chain) {
    if (!node.message) continue
    const refs = owned.get(node.id) ?? []
    if (new Set(refs.map((entry) => entry.model)).size > 1) return unresolved('mixed-model-usage')
    const model = refs.length ? refs[0].model : node.model
    if (refs.length && node.model !== null && node.model !== model)
      return unresolved('model-mismatch')
    // A captured parser total is justified only as a running sum of the checkpoints the
    // parser attributed to this message (ownership 1), whichever ownership is projected.
    const running = emptyUsage()
    const sums = new Set(
      (parserOwned.get(node.id) ?? []).map((entry) => usageKey(addUsage(running, entry.usage)))
    )
    if (node.usages.some((observed) => observed !== null && !sums.has(usageKey(observed))))
      return unresolved('usage-mismatch')
    const total = emptyUsage()
    for (const entry of refs) addUsage(total, entry.usage)
    messages.push({
      ...node.message,
      toolNames: [...node.message.toolNames],
      timestamp: node.timestamp,
      sessionId: conversationId,
      cwd: null,
      gitBranch: null,
      model,
      usage: refs.length ? total : null,
      uuid: node.id,
      parentUuid: node.parent
    })
  }

  const events: CodexEventReference[] = [
    ...chain.flatMap((node): CodexEventReference[] =>
      node.message || !ancestryOnlyKinds.includes(node.kind)
        ? [
            {
              eventId: node.id,
              observationId: node.observationIds[0],
              observationIds: node.observationIds,
              kind: node.message ? 'message' : 'progress',
              timestamp: node.timestamp
            }
          ]
        : []
    ),
    ...checkpointEvents,
    ...progressEvents
  ]
  events.sort((a, b) =>
    a.timestamp < b.timestamp
      ? -1
      : a.timestamp > b.timestamp
        ? 1
        : a.eventId < b.eventId
          ? -1
          : a.eventId > b.eventId
            ? 1
            : 0
  )
  // Includes usage recorded before any assistant, as the parser's session total does.
  const totalTokenUsage = emptyUsage()
  for (const entry of usage) addUsage(totalTokenUsage, entry.usage)
  return {
    ...base,
    status: 'resolved',
    events,
    usage,
    recording: {
      sessionId: conversationId,
      tool: 'codex',
      sourceFile: '',
      projectDirectory: null,
      projectPathEncoded: '',
      messages,
      progressTimestamps: events
        .filter((event) => event.kind === 'progress')
        .map((event) => event.timestamp)
        .sort(),
      firstTimestamp: messages[0].timestamp,
      lastTimestamp: messages[messages.length - 1].timestamp,
      totalTokenUsage,
      subagentTokenUsage: emptyUsage(),
      subagentMessages: [],
      subagentProgressTimestamps: [],
      models: [
        ...new Set([...messages, ...usage].flatMap((entry) => (entry.model ? [entry.model] : [])))
      ].sort(),
      messageCount: messages.length,
      summary: null
    }
  }
}

/**
 * Captured Codex ledger only. Linear histories resolve; forks, corrections and any
 * unresolved checkpoint hold the whole conversation. Usage comes from checkpoint
 * deltas, never from the parser's mutable per-message totals. Anchored progress leaves
 * add time evidence only. `checkpointOwnership` defaults to the parser-compatible 1; callers
 * must record which ownership produced a coverage before comparing it with another.
 */
export function readCanonicalCodexActivity(
  db: Pick<ReturnType<typeof getDb>, 'select'>,
  conversationIds?: readonly string[],
  options: { checkpointOwnership?: CodexCheckpointOwnership } = {}
): CanonicalCodexConversation[] {
  if (conversationIds?.length === 0) return []
  const rows = db
    .select({ identity: activityIdentities, observation: activityObservations })
    .from(activityIdentities)
    .leftJoin(activityObservations, eq(activityObservations.eventId, activityIdentities.eventId))
    .where(
      and(
        eq(activityIdentities.provider, 'codex'),
        conversationIds
          ? inArray(activityIdentities.conversationId, [...conversationIds])
          : undefined
      )
    )
    .orderBy(activityIdentities.conversationId, activityIdentities.eventId, activityObservations.id)
    .all()
  const deltas = new Map<string, CodexCheckpointDelta[]>()
  for (const delta of readCodexCheckpointDeltas(db, conversationIds)) {
    const list = deltas.get(delta.conversationId) ?? []
    list.push(delta)
    deltas.set(delta.conversationId, list)
  }
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const group = groups.get(row.identity.conversationId) ?? []
    group.push(row)
    groups.set(row.identity.conversationId, group)
  }
  return [...groups].map(([conversationId, group]) =>
    project(conversationId, group, deltas.get(conversationId) ?? [], options.checkpointOwnership)
  )
}

const referenceKeys = [
  'checkpointId',
  'observationId',
  'messageEventId',
  'timestamp',
  'model',
  'delta',
  'usage'
]
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * Validates persisted version-2 coverage usage exactly as the adapter produces it, or null.
 * Callers must still reject null owners and owners that are not counted messages of the
 * same interval; this validator cannot see the interval.
 */
export function readCanonicalCoverageUsage(value: unknown): CodexUsageReference[] | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  const result: CodexUsageReference[] = []
  for (const entry of value) {
    if (
      !object(entry) ||
      Object.keys(entry).length !== referenceKeys.length ||
      !referenceKeys.every((key) => Object.hasOwn(entry, key))
    )
      return null
    const { checkpointId, observationId, messageEventId, timestamp, model, delta } = entry
    const usage = tokens(entry.usage)
    if (
      typeof checkpointId !== 'string' ||
      !checkpointId.trim() ||
      seen.has(checkpointId) ||
      typeof observationId !== 'string' ||
      !observationId.trim() ||
      !reference(messageEventId) ||
      !reference(model) ||
      typeof timestamp !== 'string' ||
      instant(timestamp) !== timestamp ||
      !object(delta) ||
      !['input_tokens', 'output_tokens', 'cached_input_tokens'].every((key) =>
        Object.hasOwn(delta, key)
      ) ||
      !Object.values(delta).every(count) ||
      !usage
    )
      return null
    const input = delta.input_tokens as number
    const cached = delta.cached_input_tokens as number
    const output = delta.output_tokens as number
    // The adapter records only nonzero deltas with a valid cached/uncached split.
    if (
      cached > input ||
      (!input && !cached && !output) ||
      usage.inputTokens !== input - cached ||
      usage.outputTokens !== output ||
      usage.cacheReadInputTokens !== cached
    )
      return null
    seen.add(checkpointId)
    result.push({
      checkpointId,
      observationId,
      messageEventId,
      timestamp,
      model,
      delta: { ...(delta as Record<string, number>) },
      usage: { ...usage }
    })
  }
  return result
}

/** Checkpoint observations behind an interval's message usage; unowned usage is never included. */
export function codexCoverageUsage(
  conversation: Extract<CanonicalCodexConversation, { status: 'resolved' }>,
  coverage: Pick<CanonicalIntervalCoverage, 'messages'>
): CodexUsageReference[] {
  const members = new Set(coverage.messages.map((event) => event.eventId))
  return conversation.usage.filter(
    (entry) => entry.messageEventId !== null && members.has(entry.messageEventId)
  )
}
