import { createHash } from 'node:crypto'

export interface OpencodeActivityIdentity {
  version: 1
  provider: 'opencode'
  conversationId: string
  eventId: string
  basis: 'native'
  nativeEventId: string
  kind: 'message' | 'part'
  /** Explicit reply/owning-message link; absent means unknown, not a root. */
  parentEventId?: string
}

export interface OpencodeActivityEvidence {
  version: 1
  status: 'captured' | 'unavailable'
  reason: string | null
  /** Session-level parent (e.g. a subagent), not a message predecessor. */
  parentConversationId: string | null
  activities: Array<{
    identity: OpencodeActivityIdentity
    kind: string
    /** Mutable measurements, excluded from the native event key. */
    timing?: { startedAt?: string; endedAt?: string; completedAt?: string }
  }>
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function key(conversationId: string, kind: 'message' | 'part', id: string, owner?: string): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(['opencode', 1, conversationId, 'native', kind, owner ?? null, id]))
    .digest('hex')
  return `opencode:v1:native:${hash}`
}

/** Native document-store evidence only; missing IDs never fall back to filenames. */
export class OpencodeIdentityCapture {
  private failure: string | null = null
  private activities: OpencodeActivityEvidence['activities'] = []

  constructor(
    private conversationId: unknown,
    private parentConversationId: unknown
  ) {
    if (!nonempty(conversationId)) this.invalidate('missing-session-identity')
    if (parentConversationId != null && !nonempty(parentConversationId))
      this.invalidate('invalid-session-parent')
  }

  invalidate(reason: string): void {
    this.failure ??= reason
  }

  message(raw: unknown): OpencodeActivityIdentity | null {
    if (this.failure || !nonempty(this.conversationId)) return null
    if (
      !object(raw) ||
      !nonempty(raw.id) ||
      raw.sessionID !== this.conversationId ||
      !['user', 'assistant'].includes(String(raw.role)) ||
      !object(raw.time) ||
      typeof raw.time.created !== 'number' ||
      !Number.isSafeInteger(raw.time.created) ||
      raw.time.created <= 0 ||
      !Number.isFinite(new Date(raw.time.created).getTime()) ||
      (raw.parentID != null && !nonempty(raw.parentID))
    ) {
      this.invalidate('incomplete-message')
      return null
    }
    const identity: OpencodeActivityIdentity = {
      version: 1,
      provider: 'opencode',
      conversationId: this.conversationId,
      eventId: key(this.conversationId, 'message', raw.id),
      basis: 'native',
      nativeEventId: raw.id,
      kind: 'message',
      ...(nonempty(raw.parentID)
        ? { parentEventId: key(this.conversationId, 'message', raw.parentID) }
        : {})
    }
    const completedAt = raw.role === 'assistant' ? isoTimestamp(raw.time.completed) : undefined
    this.activities.push({
      identity,
      kind: String(raw.role),
      ...(completedAt ? { timing: { completedAt } } : {})
    })
    return identity
  }

  part(raw: unknown, messageId: string): void {
    if (this.failure || !nonempty(this.conversationId)) return
    if (
      !object(raw) ||
      !nonempty(raw.id) ||
      !nonempty(raw.type) ||
      raw.sessionID !== this.conversationId ||
      raw.messageID !== messageId
    ) {
      this.invalidate('incomplete-part')
      return
    }
    const state = raw.type === 'tool' && object(raw.state) ? raw.state : null
    const time = state && object(state.time) ? state.time : null
    const startedAt = isoTimestamp(time?.start)
    const endedAt = isoTimestamp(time?.end)
    this.activities.push({
      identity: {
        version: 1,
        provider: 'opencode',
        conversationId: this.conversationId,
        eventId: key(this.conversationId, 'part', raw.id, messageId),
        basis: 'native',
        nativeEventId: raw.id,
        kind: 'part',
        parentEventId: key(this.conversationId, 'message', messageId)
      },
      kind: raw.type,
      ...(startedAt || endedAt
        ? { timing: { ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}) } }
        : {})
    })
  }

  finish(): OpencodeActivityEvidence {
    return {
      version: 1,
      status: this.failure ? 'unavailable' : 'captured',
      reason: this.failure,
      parentConversationId: nonempty(this.parentConversationId) ? this.parentConversationId : null,
      // Directory enumeration is not ancestry. Sort only to serialize deterministically.
      activities: this.failure
        ? []
        : this.activities.sort((a, b) =>
            a.identity.eventId < b.identity.eventId
              ? -1
              : a.identity.eventId > b.identity.eventId
                ? 1
                : 0
          )
    }
  }
}
