import { describe, it, expect } from 'vitest'
import { computeEarnings, computeHumanMinutes, computeBucketedHumanMinutes } from './earnings'

const projects = [
  { id: 1, clientId: 10, hourlyRate: 150 }, // own rate
  { id: 2, clientId: 10, hourlyRate: null } // falls back to client rate
]
const clients = [{ id: 10, billableRate: 100 }]

function session(over: Partial<Parameters<typeof computeEarnings>[0][number]>) {
  return {
    projectId: 1,
    clientId: 10,
    billable: true,
    startedAt: '2026-03-01T09:00:00.000Z',
    endedAt: '2026-03-01T10:00:00.000Z',
    ...over
  }
}

describe('computeHumanMinutes', () => {
  it('merges overlapping intervals so concurrent work counts once', () => {
    const mins = computeHumanMinutes([
      { startedAt: '2026-03-01T09:00:00Z', endedAt: '2026-03-01T10:00:00Z' },
      { startedAt: '2026-03-01T09:30:00Z', endedAt: '2026-03-01T10:30:00Z' }
    ])
    expect(mins).toBe(90)
  })
})

describe('computeEarnings', () => {
  it('uses the project rate when set', () => {
    expect(computeEarnings([session({})], projects, clients)).toBe(150) // 1h × $150
  })

  it('falls back to the client rate when project rate is null', () => {
    expect(computeEarnings([session({ projectId: 2 })], projects, clients)).toBe(100) // 1h × $100
  })

  it('skips non-billable sessions', () => {
    expect(computeEarnings([session({ billable: false })], projects, clients)).toBe(0)
  })

  it('counts concurrent same-project sessions once (human hours)', () => {
    const overlapping = [
      session({}),
      session({ startedAt: '2026-03-01T09:00:00.000Z', endedAt: '2026-03-01T10:00:00.000Z' })
    ]
    expect(computeEarnings(overlapping, projects, clients)).toBe(150) // still 1 merged hour
  })

  it('bills different concurrent projects separately', () => {
    const twoProjects = [
      session({ projectId: 1 }), // $150/h
      session({ projectId: 2 }) // $100/h (client rate), same hour
    ]
    expect(computeEarnings(twoProjects, projects, clients)).toBe(250)
  })

  it('earns nothing when no effective rate exists', () => {
    expect(
      computeEarnings([session({})], [{ id: 1, clientId: 10, hourlyRate: null }], [
        { id: 10, billableRate: null }
      ])
    ).toBe(0)
  })

  it('bills unassigned sessions via the client rate', () => {
    const unassigned = session({ projectId: null, clientId: 10 })
    expect(computeEarnings([unassigned], projects, clients)).toBe(100)
  })
})

describe('computeBucketedHumanMinutes', () => {
  const at = (h: number, m = 0): string =>
    new Date(Date.UTC(2026, 7, 23, h, m)).toISOString()

  it('counts concurrent agents on one project once', () => {
    const parallel = [
      { projectId: 1, clientId: 10, startedAt: at(9), endedAt: at(12) },
      { projectId: 1, clientId: 10, startedAt: at(10), endedAt: at(11) },
      { projectId: 1, clientId: 10, startedAt: at(10, 30), endedAt: at(13) }
    ]
    // 09:00–13:00 wall clock, not 3 + 1 + 2.5 = 6.5h
    expect(computeBucketedHumanMinutes(parallel)).toBe(240)
  })

  it('still counts a gap between sessions as unworked', () => {
    const gapped = [
      { projectId: 1, clientId: 10, startedAt: at(9), endedAt: at(10) },
      { projectId: 1, clientId: 10, startedAt: at(14), endedAt: at(15) }
    ]
    expect(computeBucketedHumanMinutes(gapped)).toBe(120)
  })

  it('does not merge across projects — each client is owed its own hour', () => {
    const twoProjects = [
      { projectId: 1, clientId: 10, startedAt: at(9), endedAt: at(10) },
      { projectId: 2, clientId: 20, startedAt: at(9), endedAt: at(10) }
    ]
    expect(computeBucketedHumanMinutes(twoProjects)).toBe(120)
  })

  it('buckets unassigned sessions by client, then by path', () => {
    const byClient = [
      { projectId: null, clientId: 10, startedAt: at(9), endedAt: at(11) },
      { projectId: null, clientId: 10, startedAt: at(10), endedAt: at(12) }
    ]
    expect(computeBucketedHumanMinutes(byClient)).toBe(180)

    const byPath = [
      { projectId: null, clientId: null, projectPath: 'C:/a', startedAt: at(9), endedAt: at(11) },
      { projectId: null, clientId: null, projectPath: 'C:/a', startedAt: at(10), endedAt: at(12) },
      { projectId: null, clientId: null, projectPath: 'C:/b', startedAt: at(9), endedAt: at(10) }
    ]
    expect(computeBucketedHumanMinutes(byPath)).toBe(240)
  })

  it('returns 0 for no sessions', () => {
    expect(computeBucketedHumanMinutes([])).toBe(0)
  })
})
