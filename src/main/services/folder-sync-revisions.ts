/**
 * Pure causal revision engine for mutable synced records (folder-sync-plan.md decisions E, G, H).
 *
 * A revision change edits one record (entityType + entityId). Its payload is exactly
 *
 *   { fields: { [field]: { value: JSONValue, parents: changeID[] } } }
 *
 * `parents` lists the revisions of that same field on the same record that the author observed
 * and supersedes. Every parent must also appear in the change's `dependencies`. The engine-owned
 * field `$present` is written by every revision: true on create/edit/restore, false on delete.
 *
 * Per field, heads are the revisions no other revision names as a parent. Heads with one value
 * show that value (all heads stay listed so the next edit supersedes each). Heads with different
 * values are a conflict: retain the most recent agreed common value (walking past conflicting
 * common ancestors when necessary), plus every alternative. Only a resolution whose expected heads match
 * the current heads exactly supersedes a conflict or a deletion. Timestamps, arrival order and
 * input order never decide a value; nothing here persists data or reads the clock.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface FieldRevision {
  value: JsonValue
  parents: string[]
}

/** Structural subset of the protocol SyncChange that carries a revision. */
export interface RevisionChange {
  id: string
  kind: 'revision'
  entityType: string
  entityId: string
  dependencies: string[]
  payload: { fields: Record<string, FieldRevision> }
}

export interface RecordSchema {
  entityType: string
  /** Mutable synced fields. Every other field name is rejected. */
  fields: readonly string[]
  /** Shown while a field has never been written; also written by create. */
  defaults?: Readonly<Record<string, JsonValue>>
  /** Domain type check applied to incoming and planned values. */
  validate?: (field: string, value: JsonValue) => boolean
}

export interface ParsedRevision {
  id: string
  entityType: string
  entityId: string
  dependencies: string[]
  fields: Map<string, FieldRevision>
}

export interface FieldView {
  status: 'unset' | 'resolved' | 'conflict'
  /** Agreed head value, the default while unset, or the last common value while conflicted. */
  value?: JsonValue
  /** Every current head, sorted by change ID, including equal-valued heads. */
  heads: { id: string; value: JsonValue }[]
  /** Conflicts only: the common ancestors whose agreed value is retained. */
  base: string[]
}

export interface RecordView {
  entityType: string
  entityId: string
  lifecycle: 'missing' | 'present' | 'deleted' | 'conflict'
  present: FieldView
  /** Every schema field. Deleted records keep their last values for audit. */
  fields: Record<string, FieldView>
  /** Head IDs per field including `$present`; pass as observedHeads/expectedHeads. */
  heads: Record<string, string[]>
  /** Conflicted field names, `$present` included; any entry blocks billing use. */
  conflicts: string[]
  /** Revisions waiting for absent parents (directly or through a waiting ancestor). */
  deferred: { id: string; missing: string[] }[]
}

export type HeadsByField = Readonly<Record<string, readonly string[]>>
type Values = Readonly<Record<string, JsonValue>>

export type RevisionAction =
  | { type: 'create'; values?: Values }
  | { type: 'edit'; observedHeads: HeadsByField; values: Values }
  | { type: 'delete'; observedHeads: HeadsByField }
  /** Explicit resolution/restore: every written field must name exactly its current heads. */
  | { type: 'resolve'; expectedHeads: HeadsByField; values?: Values; present?: boolean }

export interface RevisionPlan {
  /** New change ID. Bootstrap passes a stable baseline ID so clones produce the same change. */
  id: string
  schema: RecordSchema
  entityId: string
  /** Complete local revision history of this record. */
  history: readonly unknown[]
  action: RevisionAction
  /** Extra applied changes this revision relies on, such as a referenced client. */
  dependencies?: readonly string[]
}

export const PRESENT = '$present'

export class RevisionError extends Error {}

const CHANGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const UNSAFE_NAMES = new Set(['constructor', 'prototype'])

function fail(message: string): never {
  throw new RevisionError(message)
}

function isChangeId(value: unknown): value is string {
  return typeof value === 'string' && CHANGE_ID.test(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join() === keys.join()
}

function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++)
      if (!isJson(value[index], depth + 1)) return false
    return true
  }
  return (
    isPlainObject(value) &&
    Object.keys(value).every((key) => key !== '__proto__' && isJson(value[key], depth + 1))
  )
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    const entries = Object.keys(object).sort()
    return `{${entries.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  }
  return String(JSON.stringify(value))
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id < right.id ? -1 : 1
}

function allowedFields(schema: RecordSchema): Set<string> {
  if (typeof schema.entityType !== 'string' || !schema.entityType)
    fail('Schema needs an entity type')
  const allowed = new Set<string>()
  for (const field of schema.fields) {
    if (!FIELD_NAME.test(field) || UNSAFE_NAMES.has(field) || allowed.has(field))
      fail(`Invalid ${schema.entityType} field name ${field}`)
    allowed.add(field)
  }
  for (const field of Object.keys(schema.defaults ?? {})) {
    if (!allowed.has(field)) fail(`Default for unknown ${schema.entityType} field ${field}`)
    checkValue(schema, field, schema.defaults?.[field], 'Default')
  }
  return allowed
}

function checkValue(schema: RecordSchema, field: string, value: unknown, owner: string): void {
  const valid =
    field === PRESENT
      ? typeof value === 'boolean'
      : isJson(value) && (schema.validate?.(field, value) ?? true)
  if (!valid) fail(`${owner} has an invalid ${field} value`)
}

function readIds(value: unknown, self: string, label: string): string[] {
  if (!Array.isArray(value) || !value.every(isChangeId)) fail(`Change ${self} has invalid ${label}`)
  if (new Set(value).size !== value.length) fail(`Change ${self} repeats ${label}`)
  if (value.includes(self)) fail(`Change ${self} cannot depend on itself`)
  return [...value]
}

/** Structurally validates one revision change against the entity's field allowlist. */
export function readRevisionChange(change: unknown, schema: RecordSchema): ParsedRevision {
  const allowed = allowedFields(schema)
  if (!isPlainObject(change)) fail('Revision change must be an object')
  const { id, payload } = change
  if (!isChangeId(id)) fail('Revision change has an invalid ID')
  if (change.kind !== 'revision') fail(`Change ${id} is not a revision`)
  if (change.entityType !== schema.entityType) fail(`Change ${id} is not a ${schema.entityType}`)
  const entityId = change.entityId
  if (typeof entityId !== 'string' || !entityId || entityId.length > 512)
    fail(`Change ${id} has an invalid entity ID`)
  const dependencies = readIds(change.dependencies, id, 'dependencies')
  if (!isPlainObject(payload) || !hasKeys(payload, ['fields']) || !isPlainObject(payload.fields))
    fail(`Change ${id} payload must be { fields }`)

  const fields = new Map<string, FieldRevision>()
  for (const field of Object.keys(payload.fields)) {
    if (field !== PRESENT && !allowed.has(field)) fail(`Change ${id} writes unknown field ${field}`)
    const revision = payload.fields[field]
    if (!isPlainObject(revision) || !hasKeys(revision, ['parents', 'value']))
      fail(`Change ${id} field ${field} must be { value, parents }`)
    const parents = readIds(revision.parents, id, `${field} parents`)
    const unlisted = parents.find((parent) => !dependencies.includes(parent))
    if (unlisted) fail(`Change ${id} must list parent ${unlisted} in dependencies`)
    checkValue(schema, field, revision.value, `Change ${id}`)
    fields.set(field, { value: revision.value as JsonValue, parents })
  }
  if (!fields.has(PRESENT)) fail(`Change ${id} must write ${PRESENT}`)
  return { id, entityType: schema.entityType, entityId, dependencies, fields }
}

/** True when two copies of a change ID carry identical content (a harmless replay). */
export function sameRevisionChange(left: unknown, right: unknown): boolean {
  const pick = (change: unknown): unknown => {
    const { id, kind, entityType, entityId, dependencies, payload } = change as RevisionChange
    return { id, kind, entityType, entityId, dependencies, payload }
  }
  return sameJson(pick(left), pick(right))
}

/**
 * Import-time check against applied changes. Throws when invalid, including a parent that is a
 * fact, belongs to another record, or did not write that field. Returns absent parent IDs; the
 * store defers the change until they are applied (lookup must return applied changes only).
 */
export function checkRevision(
  change: unknown,
  schema: RecordSchema,
  lookup: (id: string) => unknown
): string[] {
  const revision = readRevisionChange(change, schema)
  const missing = new Set<string>()
  for (const [field, { parents }] of revision.fields) {
    for (const parentId of parents) {
      const found = lookup(parentId)
      if (found === undefined) {
        missing.add(parentId)
        continue
      }
      const parent: Record<string, unknown> = isPlainObject(found) ? found : {}
      if (
        parent.kind !== 'revision' ||
        parent.entityType !== revision.entityType ||
        parent.entityId !== revision.entityId
      )
        fail(`Parent ${parentId} of ${revision.id} is not a revision of the same record`)
      if (!readRevisionChange(found, schema).fields.has(field))
        fail(`Parent ${parentId} of ${revision.id} did not write ${field}`)
    }
  }
  return [...missing].sort()
}

function lastCommon(heads: string[], writes: Map<string, FieldRevision>): string[] {
  let common: Set<string> | undefined
  for (const head of heads) {
    const reach = new Set<string>()
    const stack = [head]
    while (stack.length) {
      const id = stack.pop() as string
      if (reach.has(id)) continue
      reach.add(id)
      stack.push(...(writes.get(id)?.parents ?? []))
    }
    common = common ? new Set([...common].filter((id) => reach.has(id))) : reach
  }
  // Common ancestors are ancestor-closed, so anything named as a parent is not maximal.
  const covered = new Set([...(common ?? [])].flatMap((id) => writes.get(id)?.parents ?? []))
  return [...(common ?? [])].filter((id) => !covered.has(id)).sort()
}

function fieldView(writes: Map<string, FieldRevision>, fallback?: JsonValue): FieldView {
  const superseded = new Set([...writes.values()].flatMap((write) => write.parents))
  const heads = [...writes]
    .filter(([id]) => !superseded.has(id))
    .map(([id, write]) => ({ id, value: write.value }))
    .sort(byId)
  if (!heads.length)
    return fallback === undefined
      ? { status: 'unset', heads, base: [] }
      : { status: 'unset', value: fallback, heads, base: [] }
  if (heads.every((head) => sameJson(head.value, heads[0].value)))
    return { status: 'resolved', value: heads[0].value, heads, base: [] }
  let base = lastCommon(
    heads.map((head) => head.id),
    writes
  )
  while (base.length) {
    const values = base.map((id) => writes.get(id)!.value)
    if (values.every((value) => sameJson(value, values[0])))
      return { status: 'conflict', value: values[0], heads, base }
    // Concurrent resolutions can share conflicting ancestors. Keep walking to their
    // last agreed value rather than blanking an existing value or choosing one branch.
    base = lastCommon(base, writes)
  }
  return { status: 'conflict', heads, base: [] }
}

function build(
  schema: RecordSchema,
  entityId: string,
  changes: readonly unknown[]
): { view: RecordView; accepted: Map<string, ParsedRevision>; known: Set<string> } {
  allowedFields(schema)
  const revisions = new Map<string, ParsedRevision>()
  const copies = new Map<string, unknown>()
  for (const change of changes) {
    const revision = readRevisionChange(change, schema)
    if (revision.entityId !== entityId) fail(`Change ${revision.id} belongs to another record`)
    const earlier = copies.get(revision.id)
    if (earlier !== undefined && !sameRevisionChange(earlier, change))
      fail(`Change ${revision.id} was replayed with different contents`)
    copies.set(revision.id, change)
    revisions.set(revision.id, revision)
  }

  // Topological order over dependencies present in this history; leftovers form a cycle.
  const children = new Map<string, string[]>()
  const waiting = new Map<string, number>()
  for (const revision of revisions.values()) {
    const present = revision.dependencies.filter((id) => revisions.has(id))
    waiting.set(revision.id, present.length)
    for (const parent of present) {
      const list = children.get(parent)
      if (list) list.push(revision.id)
      else children.set(parent, [revision.id])
    }
  }
  const ready = [...waiting].filter(([, count]) => count === 0).map(([id]) => id)
  const order: ParsedRevision[] = []
  while (ready.length) {
    const id = ready.pop() as string
    order.push(revisions.get(id) as ParsedRevision)
    for (const child of children.get(id) ?? []) {
      const count = (waiting.get(child) ?? 0) - 1
      waiting.set(child, count)
      if (count === 0) ready.push(child)
    }
  }
  if (order.length < revisions.size) fail(`Revisions of ${entityId} contain a dependency cycle`)

  // Absent parents defer a revision and its descendants; absent non-parent dependencies are
  // outside this record and are the store's responsibility.
  const accepted = new Map<string, ParsedRevision>()
  const blocked = new Map<string, string[]>()
  for (const revision of order) {
    const parents = new Set([...revision.fields.values()].flatMap((write) => write.parents))
    const missing = new Set<string>()
    for (const dependency of revision.dependencies) {
      if (!revisions.has(dependency)) {
        if (parents.has(dependency)) missing.add(dependency)
      } else blocked.get(dependency)?.forEach((id) => missing.add(id))
    }
    if (missing.size) {
      blocked.set(revision.id, [...missing].sort())
      continue
    }
    for (const [field, write] of revision.fields)
      for (const parent of write.parents)
        if (!accepted.get(parent)?.fields.has(field))
          fail(`Change ${revision.id} names ${parent}, which did not write ${field}`)
    accepted.set(revision.id, revision)
  }

  const writesOf = (field: string): Map<string, FieldRevision> => {
    const writes = new Map<string, FieldRevision>()
    for (const revision of accepted.values()) {
      const write = revision.fields.get(field)
      if (write) writes.set(revision.id, write)
    }
    return writes
  }
  const present = fieldView(writesOf(PRESENT))
  const fields: Record<string, FieldView> = {}
  const heads: Record<string, string[]> = { [PRESENT]: present.heads.map((head) => head.id) }
  for (const field of schema.fields) {
    const defaults = schema.defaults ?? {}
    fields[field] = fieldView(
      writesOf(field),
      Object.hasOwn(defaults, field) ? defaults[field] : undefined
    )
    heads[field] = fields[field].heads.map((head) => head.id)
  }
  const lifecycle =
    present.status === 'unset'
      ? 'missing'
      : present.status === 'conflict'
        ? 'conflict'
        : present.value
          ? 'present'
          : 'deleted'
  const view: RecordView = {
    entityType: schema.entityType,
    entityId,
    lifecycle,
    present,
    fields,
    heads,
    conflicts: [PRESENT, ...schema.fields]
      .filter((field) => (field === PRESENT ? present : fields[field]).status === 'conflict')
      .sort(),
    deferred: [...blocked].map(([id, missing]) => ({ id, missing })).sort(byId)
  }
  return { view, accepted, known: new Set(revisions.keys()) }
}

/**
 * Materializes one record from its immutable revision changes, in any order and with replays.
 * Throws on invalid or conflicting content and dependency cycles; the store should already have
 * rejected those at import through checkRevision.
 */
export function materializeRecord(
  schema: RecordSchema,
  entityId: string,
  changes: readonly unknown[]
): RecordView {
  return build(schema, entityId, changes).view
}

/**
 * Plans a new local revision. Edits and deletes supersede only the heads the caller observed, so
 * unseen concurrent work becomes a conflict. Deleted or lifecycle-conflicted records and
 * conflicted fields accept only a resolve whose expected heads are current.
 */
export function planRevision(plan: RevisionPlan): RevisionChange {
  const { id, schema, entityId, action } = plan
  if (!isChangeId(id)) fail('Planned revision has an invalid ID')
  const allowed = allowedFields(schema)
  const { view, accepted, known } = build(schema, entityId, plan.history)
  if (known.has(id)) fail(`Change ${id} already exists`)

  const fields: Record<string, FieldRevision> = {}
  const write = (field: string, value: unknown, parents: readonly string[]): void => {
    checkValue(schema, field, value, `Revision of ${entityId}`)
    fields[field] = { value: value as JsonValue, parents: [...parents].sort() }
  }
  const fieldsOf = (values: Values | undefined): string[] => {
    if (values === undefined) return []
    if (!isPlainObject(values)) fail('Revision values must be an object')
    const names = Object.keys(values)
    const unknown = names.find((field) => !allowed.has(field))
    if (unknown !== undefined) fail(`Cannot write ${schema.entityType} field ${unknown}`)
    return names
  }
  const headsFor = (heads: HeadsByField, field: string, exact: boolean): readonly string[] => {
    const list = isPlainObject(heads) && Object.hasOwn(heads, field) ? heads[field] : undefined
    if (!Array.isArray(list) || !list.every(isChangeId) || new Set(list).size !== list.length)
      fail(`Observed heads for ${field} are required`)
    const unknown = list.find((head) => !accepted.get(head)?.fields.has(field))
    if (unknown) fail(`${unknown} is not a known ${field} revision of ${entityId}`)
    if (exact && !sameJson([...list].sort(), view.heads[field]))
      fail(`Stale resolution: ${field} of ${entityId} has changed`)
    return list
  }
  const requirePresent = (verb: string): void => {
    if (view.lifecycle !== 'present')
      fail(`Cannot ${verb} ${entityId} while it is ${view.lifecycle}; resolve it explicitly`)
  }

  if (action.type === 'create') {
    if (view.lifecycle !== 'missing') fail(`${entityId} already exists`)
    const values = action.values ?? {}
    const names = new Set(fieldsOf(values))
    write(PRESENT, true, [])
    for (const field of schema.fields) {
      if (names.has(field)) write(field, values[field], [])
      else if (schema.defaults && Object.hasOwn(schema.defaults, field))
        write(field, schema.defaults[field], [])
    }
  } else if (action.type === 'edit') {
    requirePresent('edit')
    const names = fieldsOf(action.values)
    if (!names.length) fail('An edit must change at least one field')
    write(PRESENT, true, headsFor(action.observedHeads, PRESENT, false))
    for (const field of names) {
      if (view.fields[field].status === 'conflict')
        fail(`Resolve the ${field} conflict on ${entityId} before editing it`)
      write(field, action.values[field], headsFor(action.observedHeads, field, false))
    }
  } else if (action.type === 'delete') {
    requirePresent('delete')
    write(PRESENT, false, headsFor(action.observedHeads, PRESENT, false))
  } else if (action.type === 'resolve') {
    if (view.lifecycle === 'missing') fail(`${entityId} does not exist`)
    if (action.present === undefined && view.lifecycle === 'conflict')
      fail(`Choose whether ${entityId} stays deleted`)
    const present = action.present ?? view.present.value
    const names = fieldsOf(action.values)
    if (!names.length && present === view.present.value && view.lifecycle !== 'conflict')
      fail('Nothing to resolve')
    write(PRESENT, present, headsFor(action.expectedHeads, PRESENT, true))
    for (const field of names)
      write(field, action.values?.[field], headsFor(action.expectedHeads, field, true))
  } else fail('Unknown revision action')

  const extra = readIds([...(plan.dependencies ?? [])], id, 'dependencies')
  const parents = Object.values(fields).flatMap((field) => field.parents)
  const change: RevisionChange = {
    id,
    kind: 'revision',
    entityType: schema.entityType,
    entityId,
    dependencies: [...new Set([...parents, ...extra])].sort(),
    payload: { fields }
  }
  readRevisionChange(change, schema)
  return change
}
