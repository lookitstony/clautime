// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  PRESENT,
  RevisionError,
  checkRevision,
  materializeRecord,
  planRevision,
  readRevisionChange,
  sameRevisionChange,
  type JsonValue,
  type RecordSchema,
  type RecordView,
  type RevisionAction,
  type RevisionChange
} from './folder-sync-revisions'

const schema: RecordSchema = {
  entityType: 'project',
  fields: ['name', 'rate', 'billable'],
  defaults: { billable: true },
  validate: (field, value) => field !== 'billable' || typeof value === 'boolean'
}

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const plan = (
  id: number,
  history: readonly unknown[],
  action: RevisionAction,
  entityId = 'p1'
): RevisionChange => planRevision({ id: uuid(id), schema, entityId, history, action })

const view = (changes: readonly unknown[], entityId = 'p1'): RecordView =>
  materializeRecord(schema, entityId, changes)

const edit = (current: RecordView, values: Record<string, JsonValue>): RevisionAction => ({
  type: 'edit',
  observedHeads: current.heads,
  values
})

const raw = (
  id: number,
  fields: Record<string, { value: unknown; parents: string[] }>,
  dependencies = [...new Set(Object.values(fields).flatMap((field) => field.parents))].sort(),
  entityId = 'p1'
): unknown => ({
  id: uuid(id),
  kind: 'revision',
  entityType: 'project',
  entityId,
  dependencies,
  payload: { fields }
})

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest
    ])
  )
}

/** Store simulation: validate on arrival, apply once every dependency is applied, else defer. */
function deliver(arrivals: readonly RevisionChange[]): RecordView {
  const applied = new Map<string, RevisionChange>()
  let pending: RevisionChange[] = []
  for (const change of arrivals) {
    pending.push(change)
    for (let progress = true; progress; ) {
      progress = false
      pending = pending.filter((candidate) => {
        const existing = applied.get(candidate.id)
        if (existing) {
          expect(sameRevisionChange(existing, candidate)).toBe(true)
          return false
        }
        if (candidate.dependencies.some((id) => !applied.has(id))) return true
        expect(checkRevision(candidate, schema, (id) => applied.get(id))).toEqual([])
        applied.set(candidate.id, candidate)
        progress = true
        return false
      })
    }
  }
  return view([...applied.values()])
}

function expectConvergence(changes: RevisionChange[]): RecordView {
  const expected = view(changes)
  expect(expected.deferred).toEqual([])
  for (const order of permutations(changes)) expect(deliver(order)).toEqual(expected)
  return expected
}

const root = plan(1, [], { type: 'create', values: { name: 'Site', rate: 100 } })

describe('folder sync revisions', () => {
  it('creates records with every lifecycle and default field written', () => {
    expect(root).toEqual({
      id: uuid(1),
      kind: 'revision',
      entityType: 'project',
      entityId: 'p1',
      dependencies: [],
      payload: {
        fields: {
          [PRESENT]: { value: true, parents: [] },
          name: { value: 'Site', parents: [] },
          rate: { value: 100, parents: [] },
          billable: { value: true, parents: [] }
        }
      }
    })
    const created = view([root])
    expect(created.lifecycle).toBe('present')
    expect(created.fields.name).toEqual({
      status: 'resolved',
      value: 'Site',
      heads: [{ id: root.id, value: 'Site' }],
      base: []
    })
    const missing = view([])
    expect(missing.lifecycle).toBe('missing')
    expect(missing.fields.billable).toEqual({ status: 'unset', value: true, heads: [], base: [] })
    expect(() => plan(2, [root], { type: 'create' })).toThrow(/already exists/)
  })

  it('merges concurrent edits to different fields in every delivery order', () => {
    const base = view([root])
    const a = plan(2, [root], edit(base, { name: 'Website' }))
    const b = plan(3, [root], edit(base, { rate: 120 }))
    const merged = expectConvergence([root, a, b])
    expect(merged.lifecycle).toBe('present')
    expect(merged.conflicts).toEqual([])
    expect(merged.fields.name.value).toBe('Website')
    expect(merged.fields.rate.value).toBe(120)
    expect(merged.heads[PRESENT]).toEqual([a.id, b.id])

    const next = plan(4, [root, a, b], edit(merged, { billable: false }))
    expect(next.payload.fields[PRESENT].parents).toEqual([a.id, b.id])
    expect(view([root, a, b, next]).heads[PRESENT]).toEqual([next.id])
  })

  it('keeps same-field alternatives with the last common value until explicitly resolved', () => {
    const base = view([root])
    const a = plan(2, [root], edit(base, { name: 'Alpha' }))
    const b = plan(3, [root], edit(base, { name: 'Beta' }))
    const conflicted = expectConvergence([root, a, b])
    expect(conflicted.fields.name).toEqual({
      status: 'conflict',
      value: 'Site',
      heads: [
        { id: a.id, value: 'Alpha' },
        { id: b.id, value: 'Beta' }
      ],
      base: [root.id]
    })
    expect(conflicted.conflicts).toEqual(['name'])
    expect(() => plan(4, [root, a, b], edit(conflicted, { name: 'Gamma' }))).toThrow(
      /Resolve the name conflict/
    )

    const resolution = plan(4, [root, a, b], {
      type: 'resolve',
      expectedHeads: conflicted.heads,
      values: { name: 'Beta' }
    })
    expect(resolution.payload.fields.name.parents).toEqual([a.id, b.id])
    const resolved = expectConvergence([root, a, b, resolution])
    expect(resolved.fields.name).toEqual({
      status: 'resolved',
      value: 'Beta',
      heads: [{ id: resolution.id, value: 'Beta' }],
      base: []
    })
    expect(resolved.conflicts).toEqual([])

    // A resolution that arrives before its parents waits; old parents never undo it.
    expect(view([root, b, resolution]).deferred).toEqual([{ id: resolution.id, missing: [a.id] }])
    expect(view([root, b, resolution]).fields.name.value).toBe('Beta')
    expect(view([resolution, b, a, root, a])).toEqual(resolved)
  })

  it('rejects stale resolutions and keeps an unseen concurrent edit as a new conflict', () => {
    const base = view([root])
    const a = plan(2, [root], edit(base, { name: 'Alpha' }))
    const b = plan(3, [root], edit(base, { name: 'Beta' }))
    const shown = view([root, a, b])
    const late = plan(4, [root], edit(base, { name: 'Late' }))
    expect(() =>
      plan(5, [root, a, b, late], {
        type: 'resolve',
        expectedHeads: shown.heads,
        values: { name: 'Beta' }
      })
    ).toThrow(/Stale resolution/)

    const resolution = plan(5, [root, a, b], {
      type: 'resolve',
      expectedHeads: shown.heads,
      values: { name: 'Beta' }
    })
    expect(expectConvergence([root, a, b, late, resolution]).fields.name).toEqual({
      status: 'conflict',
      value: 'Site',
      heads: [
        { id: late.id, value: 'Late' },
        { id: resolution.id, value: 'Beta' }
      ],
      base: [root.id]
    })
  })

  it('shows equal concurrent values while retaining every head for the next edit', () => {
    const base = view([root])
    const a = plan(2, [root], edit(base, { name: 'Same' }))
    const b = plan(3, [root], edit(base, { name: 'Same' }))
    const same = expectConvergence([root, a, b])
    expect(same.fields.name).toEqual({
      status: 'resolved',
      value: 'Same',
      heads: [
        { id: a.id, value: 'Same' },
        { id: b.id, value: 'Same' }
      ],
      base: []
    })

    const partial = plan(4, [root, a, b], {
      type: 'edit',
      observedHeads: { ...same.heads, name: [a.id] },
      values: { name: 'Other' }
    })
    expect(view([root, a, b, partial]).fields.name).toMatchObject({
      status: 'conflict',
      value: 'Site',
      base: [root.id]
    })
    const full = plan(4, [root, a, b], edit(same, { name: 'Other' }))
    expect(view([root, a, b, full]).fields.name.heads).toEqual([{ id: full.id, value: 'Other' }])
  })

  it('leaves conflicts without common ancestry unresolved instead of using the first arrival', () => {
    const one = plan(1, [], { type: 'create', values: { name: 'One' } })
    const two = plan(2, [], { type: 'create', values: { name: 'Two', rate: 50 } })
    const both = expectConvergence([one, two])
    expect(both.lifecycle).toBe('present')
    expect(both.fields.name).toEqual({
      status: 'conflict',
      heads: [
        { id: one.id, value: 'One' },
        { id: two.id, value: 'Two' }
      ],
      base: []
    })
    expect(both.fields.rate).toEqual({
      status: 'resolved',
      value: 50,
      heads: [{ id: two.id, value: 50 }],
      base: []
    })
    expect(both.fields.billable.status).toBe('resolved')

    const bare = plan(3, [], { type: 'create' }, 'p2')
    const bareView = view([bare], 'p2')
    expect(bareView.fields.rate).toEqual({ status: 'unset', heads: [], base: [] })
    const x = plan(4, [bare], edit(bareView, { rate: 10 }), 'p2')
    const y = plan(5, [bare], edit(bareView, { rate: 20 }), 'p2')
    const rate = view([bare, y, x], 'p2').fields.rate
    expect(rate).toEqual({
      status: 'conflict',
      heads: [
        { id: x.id, value: 10 },
        { id: y.id, value: 20 }
      ],
      base: []
    })
    expect(rate).not.toHaveProperty('value')
  })

  it('turns concurrent delete and edit into a lifecycle conflict until resolved', () => {
    const base = view([root])
    const removal = plan(2, [root], { type: 'delete', observedHeads: base.heads })
    const change = plan(3, [root], edit(base, { rate: 150 }))
    const history = [root, removal, change]
    const conflicted = expectConvergence(history)
    expect(conflicted.lifecycle).toBe('conflict')
    expect(conflicted.present).toEqual({
      status: 'conflict',
      value: true,
      heads: [
        { id: removal.id, value: false },
        { id: change.id, value: true }
      ],
      base: [root.id]
    })
    expect(conflicted.fields.rate.value).toBe(150)
    expect(conflicted.conflicts).toEqual([PRESENT])

    const ordinary: RevisionAction[] = [
      edit(conflicted, { name: 'Edited' }),
      { type: 'delete', observedHeads: conflicted.heads }
    ]
    for (const action of ordinary)
      expect(() => plan(4, history, action)).toThrow(/resolve it explicitly/)
    expect(() => plan(4, history, { type: 'resolve', expectedHeads: conflicted.heads })).toThrow(
      /stays deleted/
    )

    const keepDeleted = plan(4, history, {
      type: 'resolve',
      expectedHeads: conflicted.heads,
      present: false
    })
    expect(keepDeleted.payload.fields[PRESENT].parents).toEqual([removal.id, change.id])
    const deleted = expectConvergence([...history, keepDeleted])
    expect(deleted.lifecycle).toBe('deleted')
    expect(deleted.fields.rate.value).toBe(150)
    expect(deleted.fields.name.value).toBe('Site')

    const restore = plan(4, history, {
      type: 'resolve',
      expectedHeads: conflicted.heads,
      present: true
    })
    expect(expectConvergence([...history, restore]).lifecycle).toBe('present')
  })

  it('hides a causally later deletion and never resurrects it through ordinary edits', () => {
    const edited = plan(2, [root], edit(view([root]), { name: 'Renamed' }))
    const beforeDelete = view([root, edited])
    const removal = plan(3, [root, edited], { type: 'delete', observedHeads: beforeDelete.heads })
    const history = [root, edited, removal]
    const deleted = expectConvergence(history)
    expect(deleted.lifecycle).toBe('deleted')
    expect(deleted.fields.name.value).toBe('Renamed')
    expect(deleted.conflicts).toEqual([])

    expect(() => plan(4, history, edit(beforeDelete, { rate: 1 }))).toThrow(/while it is deleted/)
    expect(() => plan(4, history, { type: 'delete', observedHeads: deleted.heads })).toThrow(
      /while it is deleted/
    )
    expect(view([...history, edited, root])).toEqual(deleted)

    const restore = plan(4, history, {
      type: 'resolve',
      expectedHeads: deleted.heads,
      present: true
    })
    expect(view([...history, restore]).lifecycle).toBe('present')
  })

  it('ignores duplicate replays and rejects a reused change ID with different contents', () => {
    const a = plan(2, [root], edit(view([root]), { name: 'A' }))
    const copy = JSON.parse(JSON.stringify(a)) as RevisionChange
    expect(sameRevisionChange(a, copy)).toBe(true)
    expect(view([root, a, copy, root])).toEqual(view([root, a]))
    expect(deliver([a, root, copy, a])).toEqual(view([root, a]))

    const forged = {
      ...copy,
      payload: { fields: { ...copy.payload.fields, name: { value: 'Forged', parents: [root.id] } } }
    }
    expect(sameRevisionChange(a, forged)).toBe(false)
    expect(() => view([root, a, forged])).toThrow(/different contents/)
  })

  it('defers only revisions whose parents are absent', () => {
    const base = view([root])
    const a = plan(2, [root], edit(base, { name: 'A' }))
    const afterA = plan(3, [root, a], edit(view([root, a]), { name: 'After A' }))
    const independent = plan(4, [root], edit(base, { rate: 110 }))
    const partial = view([root, afterA, independent])
    expect(partial.deferred).toEqual([{ id: afterA.id, missing: [a.id] }])
    expect(partial.fields.rate.value).toBe(110)
    expect(partial.fields.name).toMatchObject({ status: 'resolved', value: 'Site' })
    expect(checkRevision(afterA, schema, (id) => (id === root.id ? root : undefined))).toEqual([
      a.id
    ])

    const later = plan(5, [root, a, afterA], edit(view([root, a, afterA]), { name: 'Later' }))
    expect(view([root, later, afterA, independent]).deferred).toEqual([
      { id: afterA.id, missing: [a.id] },
      { id: later.id, missing: [a.id] }
    ])
    const complete = view([root, later, afterA, independent, a])
    expect(complete.deferred).toEqual([])
    expect(complete.fields.name.value).toBe('Later')
  })

  it('keeps long-offline work as a conflict instead of reverting later edits', () => {
    const online: RevisionChange[] = [root]
    for (let n = 2; n <= 6; n++)
      online.push(plan(n, online, edit(view(online), { name: `Online ${n}` })))
    const offlineName = plan(10, [root], edit(view([root]), { name: 'Offline' }))
    const offlineRate = plan(11, [root, offlineName], edit(view([root, offlineName]), { rate: 90 }))
    const merged = view([...online, offlineName, offlineRate])
    expect(merged.fields.name).toEqual({
      status: 'conflict',
      value: 'Site',
      heads: [
        { id: uuid(6), value: 'Online 6' },
        { id: offlineName.id, value: 'Offline' }
      ],
      base: [root.id]
    })
    expect(merged.fields.rate).toMatchObject({ status: 'resolved', value: 90 })
    for (const order of [
      [offlineRate, offlineName, ...online],
      [...online].reverse().concat(offlineRate, offlineName),
      [offlineRate, ...online.slice(3), offlineName, ...online.slice(0, 3)]
    ])
      expect(deliver(order)).toEqual(merged)
  })

  it('bootstraps clones from a stable baseline change ID so pre-clone state deduplicates', () => {
    const exportBaseline = (): RevisionChange =>
      planRevision({
        id: uuid(100),
        schema,
        entityId: 'p1',
        history: [],
        action: { type: 'create', values: { name: 'Site', rate: 100 } }
      })
    const desktop = exportBaseline()
    const laptop = exportBaseline()
    expect(laptop).toEqual(desktop)

    const baseline = view([desktop])
    const desktopEdit = plan(101, [desktop], edit(baseline, { name: 'Desktop name' }))
    const laptopEdit = plan(102, [laptop], edit(baseline, { billable: false }))
    const merged = expectConvergence([desktop, laptop, desktopEdit, laptopEdit])
    expect(merged.conflicts).toEqual([])
    expect(merged.fields.name.value).toBe('Desktop name')
    expect(merged.fields.billable.value).toBe(false)
  })

  it('ignores wall-clock metadata and change ID order when detecting conflicts', () => {
    const base = view([root])
    const a = plan(2, [root], edit(base, { name: 'A' }))
    const b = plan(3, [root], edit(base, { name: 'B' }))
    const skewed = [
      { ...b, createdAt: '1999-01-01T00:00:00Z' },
      { ...root, createdAt: '2031-01-01T00:00:00Z' },
      { ...a, createdAt: '2026-09-27T00:00:00Z' }
    ]
    expect(view(skewed)).toEqual(view([root, a, b]))
    expect(view(skewed).fields.name).toMatchObject({ status: 'conflict', value: 'Site' })

    const swappedA = plan(3, [root], edit(base, { name: 'A' }))
    const swappedB = plan(2, [root], edit(base, { name: 'B' }))
    expect(view([root, swappedA, swappedB]).fields.name).toMatchObject({
      status: 'conflict',
      value: 'Site',
      heads: [
        { id: swappedB.id, value: 'B' },
        { id: swappedA.id, value: 'A' }
      ]
    })
  })

  it('rejects parents from another record, from facts, or that did not write the field', () => {
    const other = plan(50, [], { type: 'create', values: { name: 'Other' } }, 'p2')
    const fact = {
      id: uuid(51),
      kind: 'fact',
      entityType: 'activity-identity',
      entityId: 'x',
      dependencies: [],
      payload: {}
    }
    const known = [root, other, fact]
    const lookup = (id: string): unknown => known.find((change) => change.id === id)
    for (const parent of [other.id, fact.id]) {
      const forged = raw(52, {
        [PRESENT]: { value: true, parents: [parent] },
        name: { value: 'Hijacked', parents: [parent] }
      })
      expect(() => checkRevision(forged, schema, lookup)).toThrow(/same record/)
      // Without the store check such a parent is simply never present for this record.
      expect(view([root, forged]).deferred).toEqual([{ id: uuid(52), missing: [parent] }])
    }
    expect(() => view([root, other])).toThrow(/another record/)

    const rateOnly = plan(2, [root], edit(view([root]), { rate: 5 }))
    known.push(rateOnly)
    const wrongField = raw(53, {
      [PRESENT]: { value: true, parents: [rateOnly.id] },
      name: { value: 'X', parents: [rateOnly.id] }
    })
    expect(() => checkRevision(wrongField, schema, lookup)).toThrow(/did not write name/)
    expect(() => view([root, rateOnly, wrongField])).toThrow(/did not write name/)
    expect(() =>
      plan(3, [root, rateOnly], {
        type: 'edit',
        observedHeads: { ...view([root, rateOnly]).heads, name: [rateOnly.id] },
        values: { name: 'X' }
      })
    ).toThrow(/not a known name revision/)
    expect(() =>
      plan(3, [root], { type: 'edit', observedHeads: { name: [root.id] }, values: { name: 'X' } })
    ).toThrow(/Observed heads for \$present/)
  })

  it('rejects unsafe fields, invalid values, self dependencies and cycles', () => {
    const present = { value: true, parents: [] }
    const invalid: unknown[] = [
      raw(2, { [PRESENT]: present, owner: { value: 'x', parents: [] } }),
      JSON.parse(
        `{"id":"${uuid(2)}","kind":"revision","entityType":"project","entityId":"p1",` +
          `"dependencies":[],"payload":{"fields":{"$present":{"value":true,"parents":[]},` +
          `"__proto__":{"value":{},"parents":[]}}}}`
      ),
      raw(2, { [PRESENT]: present, constructor: { value: 1, parents: [] } }),
      raw(2, { name: { value: 'No lifecycle', parents: [] } }),
      raw(2, { [PRESENT]: { value: 'yes', parents: [] } }),
      raw(2, { [PRESENT]: present, billable: { value: 'no', parents: [] } }),
      raw(2, { [PRESENT]: present, rate: { value: Number.NaN, parents: [] } }),
      raw(2, { [PRESENT]: present, name: { value: [undefined], parents: [] } }),
      raw(2, { [PRESENT]: { value: true, parents: [root.id] } }, []),
      raw(2, { [PRESENT]: present }, [uuid(2)]),
      raw(2, { [PRESENT]: { value: true, parents: [root.id, root.id] } }, [root.id]),
      { ...(raw(2, { [PRESENT]: present }) as object), id: uuid(2).replace('0', 'A') },
      { ...(raw(2, { [PRESENT]: present }) as object), kind: 'fact' },
      {
        ...(raw(2, { [PRESENT]: present }) as object),
        payload: { fields: { [PRESENT]: present }, extra: 1 }
      },
      raw(2, { [PRESENT]: { ...present, note: 1 } as never })
    ]
    for (const change of invalid)
      expect(() => readRevisionChange(change, schema)).toThrow(RevisionError)

    const x = raw(20, { [PRESENT]: { value: true, parents: [uuid(21)] } })
    const y = raw(21, { [PRESENT]: { value: true, parents: [uuid(20)] } })
    expect(() => view([root, x, y])).toThrow(/cycle/)

    for (const fields of [['$present'], ['__proto__'], ['constructor'], ['name', 'name'], ['1st']])
      expect(() => materializeRecord({ entityType: 'project', fields }, 'p1', [])).toThrow(
        RevisionError
      )
    expect(() =>
      materializeRecord(
        { entityType: 'project', fields: ['name'], defaults: { rate: 1 } },
        'p1',
        []
      )
    ).toThrow(/unknown/)

    const current = view([root])
    for (const values of [{ [PRESENT]: false }, JSON.parse('{"__proto__":{"rate":1}}'), {}])
      expect(() => plan(2, [root], edit(current, values))).toThrow(RevisionError)
    expect(() => plan(2, [root], edit(current, { billable: 'yes' }))).toThrow(/invalid billable/)
    expect(() => plan(1, [root], edit(current, { name: 'Reused ID' }))).toThrow(/already exists/)
  })

  it('derives the last common value across merges and criss-cross histories', () => {
    const base = view([root])
    const a = plan(2, [root], edit(base, { name: 'A' }))
    const b = plan(3, [root], edit(base, { name: 'B' }))
    const split = view([root, a, b])
    const resolve = (id: number, name: string): RevisionChange =>
      plan(id, [root, a, b], { type: 'resolve', expectedHeads: split.heads, values: { name } })
    const keepA = resolve(4, 'A')
    const keepB = resolve(5, 'B')
    const crissCross = expectConvergence([root, a, b, keepA, keepB])
    expect(crissCross.lifecycle).toBe('present')
    expect(crissCross.fields.name).toEqual({
      status: 'conflict',
      heads: [
        { id: keepA.id, value: 'A' },
        { id: keepB.id, value: 'B' }
      ],
      value: base.fields.name.value,
      base: [root.id]
    })

    const merged = [root, a, b, keepA]
    const e = plan(6, merged, edit(view(merged), { name: 'E' }))
    const f = plan(7, merged, edit(view(merged), { name: 'F' }))
    expect(view([...merged, e, f]).fields.name).toMatchObject({
      status: 'conflict',
      value: 'A',
      base: [keepA.id]
    })

    const c = plan(8, [root], edit(base, { name: 'Same' }))
    const d = plan(9, [root], edit(base, { name: 'Same' }))
    const agreed = view([root, c, d])
    const left = plan(10, [root, c, d], edit(agreed, { name: 'Left' }))
    const right = plan(11, [root, c, d], edit(agreed, { name: 'Right' }))
    expect(view([root, c, d, left, right]).fields.name).toMatchObject({
      status: 'conflict',
      value: 'Same',
      base: [c.id, d.id]
    })
  })
})
