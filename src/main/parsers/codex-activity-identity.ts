import { createHash } from 'node:crypto'

export interface CodexActivityIdentity {
  version: 1
  provider: 'codex'
  conversationId: string
  eventId: string
  basis: 'native' | 'fingerprint'
  nativeEventId: string | null
  parentEventId: string | null
}

export interface CodexActivityRecord {
  identity: CodexActivityIdentity
  timestamp: string
  kind: string
}

export interface CodexTokenCheckpoint {
  id: string
  previousCheckpointId: string | null
  activityEventId: string | null
  timestamp: string
  /** Original cumulative counters, including cached/reasoning totals when supplied. */
  totals: Record<string, number>
  model: string | null
}

export interface CodexActivityEvidence {
  version: 1
  status: 'captured' | 'unavailable'
  reason: string | null
  activities: CodexActivityRecord[]
  /** Repeated IDs retain separate observations; no correction is silently selected. */
  checkpoints: CodexTokenCheckpoint[]
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (object(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    )
  return value
}

function key(conversationId: string, basis: string, value: unknown): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(canonical(['codex', 1, conversationId, basis, value])))
    .digest('hex')
  return `codex:v1:${basis}:${hash}`
}

function timestamped(value: unknown): value is string {
  return (
    nonempty(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

/** Parser evidence only. No file paths, line numbers or mutable counters enter event keys. */
export class CodexIdentityCapture {
  private conversationId: string | null = null
  private failure: string | null = null
  private head: string | null = null
  private checkpointHead: string | null = null
  private model: string | null = null
  private activities = new Map<string, CodexActivityRecord>()
  private checkpointParents = new Map<string, string | null>()
  private checkpoints: CodexTokenCheckpoint[] = []

  invalidate(reason = 'incomplete-stream'): void {
    this.failure ??= reason
  }

  observe(raw: Record<string, unknown>): CodexActivityIdentity | null {
    if (this.failure) return null
    const payload = raw.payload
    if (raw.type === 'session_meta') {
      if (!object(payload) || this.conversationId) {
        this.invalidate()
        return null
      }
      if (
        payload.forked_from_id != null ||
        payload.history_base != null ||
        payload.subagent_history_start_ordinal != null ||
        payload.history_mode === 'paginated'
      ) {
        this.invalidate('unresolved-fork-history')
        return null
      }
      // id is the thread ID; session_id can be shared by a root and its agents.
      const id = payload.id
      if (!nonempty(id)) this.invalidate('missing-session-identity')
      else this.conversationId = id
      return null
    }
    if (raw.type === 'turn_context' && object(payload)) {
      if (nonempty(payload.model)) this.model = payload.model
      return null
    }
    const checkpoint = raw.type === 'event_msg' && object(payload) && payload.type === 'token_count'
    if (raw.type !== 'response_item' && raw.type !== 'compacted' && !checkpoint) return null
    if (!this.conversationId || !object(payload) || !timestamped(raw.timestamp)) {
      this.invalidate('incomplete-stream')
      return null
    }
    if (checkpoint) {
      const info = payload.info
      const totals = object(info) ? info.total_token_usage : null
      // An empty token_count is only progress evidence, not a zero usage observation.
      if (totals == null) return null
      if (
        !object(totals) ||
        !['input_tokens', 'output_tokens', 'cached_input_tokens'].every((field) =>
          Object.hasOwn(totals, field)
        ) ||
        !Object.values(totals).every(
          (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        )
      ) {
        this.invalidate('invalid-token-checkpoint')
        return null
      }
      const id = key(this.conversationId, 'checkpoint', [this.head, raw.timestamp])
      if (!this.checkpointParents.has(id)) {
        this.checkpointParents.set(id, this.checkpointHead)
        this.checkpointHead = id
      }
      this.checkpoints.push({
        id,
        previousCheckpointId: this.checkpointParents.get(id)!,
        activityEventId: this.head,
        timestamp: raw.timestamp,
        totals: { ...totals } as Record<string, number>,
        model: this.model
      })
      return null
    }
    if (raw.type === 'response_item' && !nonempty(payload.type)) {
      this.invalidate()
      return null
    }
    const kind = raw.type === 'compacted' ? 'compacted' : String(payload.type)
    const nativeEventId = raw.type === 'response_item' && nonempty(payload.id) ? payload.id : null
    const basis = nativeEventId ? 'native' : 'fingerprint'
    // Keep unknown payload fields rather than lose identity evidence. Only known
    // observation/location metadata is excluded; paths inside tool arguments remain payload.
    const stablePayload = Object.fromEntries(
      Object.entries(payload).filter(
        ([field]) => !['usage', 'model', 'cwd', 'machine_id'].includes(field)
      )
    )
    const id = key(
      this.conversationId,
      basis,
      nativeEventId ? [kind, nativeEventId] : [raw.type, this.head, raw.timestamp, stablePayload]
    )
    const existing = this.activities.get(id)
    if (existing) return existing.identity
    const identity: CodexActivityIdentity = {
      version: 1,
      provider: 'codex',
      conversationId: this.conversationId,
      eventId: id,
      basis,
      nativeEventId,
      parentEventId: this.head
    }
    this.activities.set(id, { identity, timestamp: raw.timestamp, kind })
    this.head = id
    return identity
  }

  finish(): CodexActivityEvidence {
    const reason = this.failure ?? (this.conversationId ? null : 'missing-session-identity')
    return {
      version: 1,
      status: reason ? 'unavailable' : 'captured',
      reason,
      activities: reason ? [] : [...this.activities.values()],
      checkpoints: reason ? [] : this.checkpoints
    }
  }
}
