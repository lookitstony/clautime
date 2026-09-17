import { createHash } from 'node:crypto'

/** Parser evidence only; local raw-message keys and totals do not use this yet. */
export interface ClaudeActivityIdentity {
  version: 1
  provider: 'claude'
  conversationId: string
  eventId: string
  basis: 'native' | 'fingerprint'
  nativeEventId: string | null
  /** Missing means unknown; null means an explicit root in the original record. */
  parentEventId?: string | null
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Preserve array order and payload values, but ignore JSON object key ordering. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    )
  return value
}

function eventId(
  conversationId: string,
  basis: ClaudeActivityIdentity['basis'],
  value: unknown
): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(canonical(['claude', 1, conversationId, basis, value])))
    .digest('hex')
  return `claude:v1:${basis}:${hash}`
}

/** Capture identity before extractMessage discards content. Never infer it from a file path. */
export function claudeActivityIdentity(
  raw: Record<string, unknown>,
  isSubagent = false
): ClaudeActivityIdentity | null {
  if (!nonempty(raw.sessionId)) return null
  const conversationId = raw.sessionId
  const parentEventId =
    raw.parentUuid === null
      ? null
      : nonempty(raw.parentUuid)
        ? eventId(conversationId, 'native', raw.parentUuid)
        : undefined
  if (nonempty(raw.uuid))
    return {
      version: 1,
      provider: 'claude',
      conversationId,
      eventId: eventId(conversationId, 'native', raw.uuid),
      basis: 'native',
      nativeEventId: raw.uuid,
      parentEventId
    }

  // A missing predecessor is not proof of a root. Subagent filenames are not stream IDs.
  const agentId = nonempty(raw.agentId) ? raw.agentId : null
  if (parentEventId === undefined || ((isSubagent || raw.isSidechain === true) && !agentId))
    return null
  if (
    !nonempty(raw.timestamp) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(raw.timestamp) ||
    !Number.isFinite(Date.parse(raw.timestamp))
  )
    return null
  if (!['user', 'assistant', 'system'].includes(String(raw.type))) return null
  const message = raw.message as Record<string, unknown> | undefined
  const content = message?.content ?? raw.content
  if (content == null) return null
  return {
    version: 1,
    provider: 'claude',
    conversationId,
    eventId: eventId(conversationId, 'fingerprint', {
      type: raw.type,
      // Keep the original timestamp precision; Date only retains milliseconds.
      timestamp: raw.timestamp,
      parentEventId,
      agentId,
      // A response ID distinguishes otherwise identical messages; content still
      // distinguishes separate blocks belonging to the same provider response.
      ...(nonempty(message?.id) ? { messageId: message.id } : {}),
      role: message?.role ?? null,
      subtype: raw.subtype ?? null,
      content
    }),
    basis: 'fingerprint',
    nativeEventId: null,
    parentEventId
  }
}
