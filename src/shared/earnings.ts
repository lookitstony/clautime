/**
 * Shared earnings math used by the Sessions, Live, and Analytics surfaces so
 * "Earned" means the same thing everywhere.
 *
 * Earned = billable human hours × effective hourly rate, computed per project so
 * that concurrent sessions on the *same* project count once, while parallel work
 * on *different* projects each bills its own client.
 *
 * Effective rate = project.hourlyRate ?? that project's client billableRate.
 */

interface EarningsSession {
  projectId: number | null
  clientId: number | null
  /** Per-session billable flag (boolean in renderer, 0/1 integer in main — both truthy-checked). */
  billable: boolean | number
  startedAt: string
  endedAt: string
}

interface EarningsProject {
  id: number
  clientId: number
  hourlyRate: number | null
}

interface EarningsClient {
  id: number
  billableRate: number | null
}

/**
 * Merge overlapping time intervals and return total wall-clock minutes.
 * Overlapping sessions (e.g. several agents at once) count only once.
 */
export function computeHumanMinutes(intervals: { startedAt: string; endedAt: string }[]): number {
  if (intervals.length === 0) return 0

  const sorted = intervals
    .map((s) => ({ start: new Date(s.startedAt).getTime(), end: new Date(s.endedAt).getTime() }))
    .sort((a, b) => a.start - b.start)

  let totalMs = 0
  let curStart = sorted[0].start
  let curEnd = sorted[0].end

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= curEnd) {
      curEnd = Math.max(curEnd, sorted[i].end)
    } else {
      totalMs += curEnd - curStart
      curStart = sorted[i].start
      curEnd = sorted[i].end
    }
  }
  totalMs += curEnd - curStart

  return Math.round(totalMs / 60_000)
}

/**
 * Total earnings in dollars over the given sessions. Only billable sessions that
 * resolve to a positive effective rate contribute.
 */
export function computeEarnings(
  sessions: EarningsSession[],
  projects: EarningsProject[],
  clients: EarningsClient[]
): number {
  const projectMap = new Map(projects.map((p) => [p.id, p]))
  const clientRate = new Map(
    clients.filter((c) => c.billableRate != null).map((c) => [c.id, c.billableRate as number])
  )

  // Group qualifying sessions by rate bucket (project, or client for unassigned).
  const groups = new Map<string, { rate: number; sessions: EarningsSession[] }>()

  for (const s of sessions) {
    if (!s.billable) continue

    let rate: number | null = null
    let key: string | null = null

    if (s.projectId != null) {
      const p = projectMap.get(s.projectId)
      if (!p) continue
      rate = p.hourlyRate ?? clientRate.get(p.clientId) ?? null
      key = `p${s.projectId}`
    } else if (s.clientId != null) {
      rate = clientRate.get(s.clientId) ?? null
      key = `c${s.clientId}`
    }

    if (key == null || rate == null || rate <= 0) continue

    const bucket = groups.get(key)
    if (bucket) bucket.sessions.push(s)
    else groups.set(key, { rate, sessions: [s] })
  }

  let total = 0
  for (const { rate, sessions: bucketSessions } of groups.values()) {
    total += (computeHumanMinutes(bucketSessions) / 60) * rate
  }
  return total
}

/**
 * Wall-clock minutes with concurrent agents counted once.
 *
 * Overlaps are merged *within* a rate bucket (project, falling back to client,
 * falling back to raw path) and summed *across* buckets — the same grouping
 * computeEarnings uses. Two agents on one project for an hour is one hour;
 * an hour on each of two clients' projects is two hours, because each client
 * is owed its own hour.
 */
export function computeBucketedHumanMinutes(
  sessions: {
    projectId?: number | null
    clientId?: number | null
    projectPath?: string
    startedAt: string
    endedAt: string
  }[]
): number {
  const buckets = new Map<string, { startedAt: string; endedAt: string }[]>()

  for (const s of sessions) {
    const key =
      s.projectId != null
        ? `p${s.projectId}`
        : s.clientId != null
          ? `c${s.clientId}`
          : `x${s.projectPath ?? ''}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(s)
    else buckets.set(key, [s])
  }

  let total = 0
  for (const bucket of buckets.values()) total += computeHumanMinutes(bucket)
  return total
}
