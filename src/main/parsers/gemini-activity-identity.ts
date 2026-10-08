import { createHash } from 'node:crypto'

export interface GeminiActivityIdentity {
  version: 1
  provider: 'gemini'
  conversationId: string
  eventId: string
  basis: 'native' | 'fingerprint'
  nativeEventId: string | null
  /** Predecessor in the recorded snapshot; null marks its first activity. */
  parentEventId: string | null
}

export interface GeminiActivityEvidence {
  version: 1
  status: 'captured' | 'unavailable'
  reason: string | null
  /** Original array order, including progress records and repeated observations. */
  activities: Array<{ identity: GeminiActivityIdentity; timestamp: string; kind: string }>
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
    .update(JSON.stringify(canonical(['gemini', 1, conversationId, basis, value])))
    .digest('hex')
  return `gemini:v1:${basis}:${hash}`
}

/** Capture a JSON conversation snapshot before the parser discards its payloads. */
export function geminiActivityEvidence(
  conversationId: unknown,
  messages: unknown[]
): GeminiActivityEvidence {
  const unavailable = (reason: string): GeminiActivityEvidence => ({
    version: 1,
    status: 'unavailable',
    reason,
    activities: []
  })
  if (!nonempty(conversationId)) return unavailable('missing-session-identity')
  const activities: GeminiActivityEvidence['activities'] = []
  const identities = new Map<string, GeminiActivityIdentity>()
  let head: string | null = null
  for (const raw of messages) {
    if (
      !object(raw) ||
      !nonempty(raw.type) ||
      !nonempty(raw.timestamp) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
        raw.timestamp
      ) ||
      !Number.isFinite(Date.parse(raw.timestamp))
    )
      return unavailable('incomplete-snapshot')

    const nativeEventId = nonempty(raw.id) ? raw.id : null
    if (!nativeEventId && raw.content == null) return unavailable('missing-event-payload')
    const basis = nativeEventId ? 'native' : 'fingerprint'
    // Keep original content, tool arguments/results and thoughts. Only observation
    // metadata is excluded; paths inside payloads remain meaningful event data.
    const payload = Object.fromEntries(
      Object.entries(raw).filter(
        ([field]) => !['id', 'tokens', 'model', 'cwd', 'machine_id'].includes(field)
      )
    )
    const id = key(conversationId, basis, nativeEventId ?? [head, payload])
    let identity = identities.get(id)
    if (!identity) {
      identity = {
        version: 1,
        provider: 'gemini',
        conversationId,
        eventId: id,
        basis,
        nativeEventId,
        parentEventId: head
      }
      identities.set(id, identity)
      head = id
    }
    activities.push({ identity, timestamp: raw.timestamp, kind: raw.type })
  }
  return { version: 1, status: 'captured', reason: null, activities }
}
