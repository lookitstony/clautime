import { describe, it, expect } from 'vitest'
import { useGroupedSessions } from './use-sessions'
import type { Session } from '../../../../shared/types/session'
import type { Client, Project } from '../../../../shared/types/client-project'

function makeSession(overrides: Partial<Session> & Pick<Session, 'id' | 'projectPath'>): Session {
  const startedAt = overrides.startedAt ?? '2026-08-01T09:00:00.000Z'
  const durationMinutes = overrides.durationMinutes ?? 60
  // Keep the interval and the duration consistent. Grouping now merges
  // overlapping intervals, so a fixture whose timestamps contradict its
  // durationMinutes would not be testing anything real.
  const endedAt = new Date(new Date(startedAt).getTime() + durationMinutes * 60_000).toISOString()
  return {
    source: 'auto',
    description: null,
    status: 'completed',
    tool: 'claude',
    claudeSessionId: `sess-${overrides.id}`,
    promptCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    sourceFile: 'test.jsonl',
    billable: true,
    projectId: null,
    clientId: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
    startedAt,
    endedAt,
    durationMinutes
  } as Session
}

// Short project assigned to a client, long project left unassigned — so the
// hours ordering has to override both the alphabetical and assigned-first rules.
const sessions: Session[] = [
  makeSession({
    id: 1,
    projectPath: 'C:\\apps\\Alpha',
    durationMinutes: 30,
    projectId: 1,
    clientId: 1
  }),
  makeSession({ id: 2, projectPath: 'C:\\apps\\Beta', durationMinutes: 200 }),
  makeSession({
    id: 3,
    projectPath: 'C:\\apps\\Gamma',
    durationMinutes: 90,
    projectId: 2,
    clientId: 1
  })
]

const projects = [
  { id: 1, name: 'Alpha', clientId: 1 },
  { id: 2, name: 'Gamma', clientId: 1 }
] as Project[]

const clients = [{ id: 1, name: 'Acme' }] as Client[]

describe('useGroupedSessions ordering', () => {
  it('defaults to assigned groups first, unassigned last', () => {
    const groups = useGroupedSessions(sessions, projects, clients)
    expect(groups.map((g) => g.projectName)).toEqual(['Alpha', 'Gamma', 'Beta'])
  })

  it('orders by most hours first', () => {
    const groups = useGroupedSessions(sessions, projects, clients, false, 'hours-desc')
    expect(groups.map((g) => g.totalDurationMinutes)).toEqual([200, 90, 30])
  })

  it('orders by fewest hours first', () => {
    const groups = useGroupedSessions(sessions, projects, clients, false, 'hours-asc')
    expect(groups.map((g) => g.totalDurationMinutes)).toEqual([30, 90, 200])
  })

  it('sorts unassigned projects in with the rest when ordering by hours', () => {
    const groups = useGroupedSessions(sessions, projects, clients, false, 'hours-desc')
    expect(groups[0].projectName).toBe('Beta')
    expect(groups[0].isUnassigned).toBe(true)
  })

  it('sums every session in a group before comparing', () => {
    const withExtra = [
      ...sessions,
      makeSession({
        id: 4,
        projectPath: 'C:\\apps\\Alpha',
        startedAt: '2026-08-01T09:30:00.000Z',
        durationMinutes: 500,
        projectId: 1,
        clientId: 1
      })
    ]
    const groups = useGroupedSessions(withExtra, projects, clients, false, 'hours-desc')
    expect(groups[0].projectName).toBe('Alpha')
    expect(groups[0].totalDurationMinutes).toBe(530)
  })
})

describe('useGroupedSessions concurrency', () => {
  it('counts agents running at once on one project as wall clock, not a sum', () => {
    const concurrent = [
      makeSession({
        id: 10,
        projectPath: 'C:\\apps\\Alpha',
        startedAt: '2026-08-01T09:00:00.000Z',
        durationMinutes: 180,
        projectId: 1,
        clientId: 1
      }),
      makeSession({
        id: 11,
        projectPath: 'C:\\apps\\Alpha',
        startedAt: '2026-08-01T10:00:00.000Z',
        durationMinutes: 60,
        projectId: 1,
        clientId: 1
      }),
      makeSession({
        id: 12,
        projectPath: 'C:\\apps\\Alpha',
        startedAt: '2026-08-01T10:30:00.000Z',
        durationMinutes: 150,
        projectId: 1,
        clientId: 1
      })
    ]
    const groups = useGroupedSessions(concurrent, projects, clients)
    // 09:00-13:00 elapsed, not 180 + 60 + 150 = 390
    expect(groups[0].totalDurationMinutes).toBe(240)
  })
})
