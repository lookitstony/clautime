import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type {
  Session,
  SessionFilters,
  ScanResult,
  PromptTiming,
  UpdateSession
} from '../../../../shared/types/session'
import type { Client, Project } from '../../../../shared/types/client-project'
import { formatDuration, getProjectName, resolveProjectName, resolveClientName } from '@/lib/format'

async function fetchSessions(filters?: SessionFilters): Promise<Session[]> {
  const result = await window.api.sessions.getAll(filters)
  if (!result.success) throw new Error(result.error.message)
  return result.data
}

async function scanSessions(projectFilter?: string[]): Promise<ScanResult> {
  const result = await window.api.sessions.scan(undefined, projectFilter)
  if (!result.success) throw new Error(result.error.message)
  return result.data
}

async function fetchPromptTimings(sessionId: number): Promise<PromptTiming[]> {
  const result = await window.api.sessions.getPromptTimings(sessionId)
  if (!result.success) throw new Error(result.error.message)
  return result.data
}

export function usePromptTimings(sessionId: number | null) {
  return useQuery({
    queryKey: ['sessions', 'promptTimings', sessionId],
    queryFn: () => fetchPromptTimings(sessionId!),
    enabled: sessionId != null
  })
}

export function useSessions(filters?: SessionFilters) {
  return useQuery({
    queryKey: ['sessions', 'list', filters],
    queryFn: () => fetchSessions(filters)
  })
}

export function useUpdateSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: UpdateSession }) => {
      const result = await window.api.sessions.update(id, data)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    }
  })
}

export function useDeleteSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      const result = await window.api.sessions.delete(id)
      if (!result.success) throw new Error(result.error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    }
  })
}

export function useSplitSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, splitAt }: { id: number; splitAt: string }) => {
      const result = await window.api.sessions.split(id, splitAt)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    }
  })
}

export function useCreateSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: {
      projectPath: string
      startedAt: string
      endedAt: string
      durationMinutes: number
      description?: string
      projectId?: number | null
      clientId?: number | null
    }) => {
      const result = await window.api.sessions.create(data)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      toast.success('Manual session created')
    }
  })
}

export function useSessionSummary(sessionId: number | null) {
  return useQuery({
    queryKey: ['ai', 'summary', sessionId],
    queryFn: async () => {
      const result = await window.api.ai.getSummary(sessionId!)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    enabled: sessionId != null
  })
}

export function useGenerateSummary() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (sessionId: number) => {
      const result = await window.api.ai.generateSummary(sessionId)
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai', 'summary'] })
      toast.success('Summary generated')
    }
  })
}

export function useScanSessions() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (projectFilter?: string[]) => scanSessions(projectFilter),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      // Git scan runs automatically after session scan; refresh after a short delay
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['git'] })
      }, 3000)
      const parts: string[] = [`${result.newSessions} sessions found`]
      if (result.attributedCount > 0) {
        parts.push(`${result.attributedCount} attributed`)
      }
      toast.success(`Scan complete: ${parts.join(', ')}`)
    }
  })
}

export interface SessionStats {
  humanHours: string
  totalHours: string
  totalSessions: number
  totalPrompts: number
  totalTokens: number
  clientCount: number
  commitSessions: number
}

export interface ProjectGroup {
  projectPath: string
  projectName: string
  clientName: string | null
  clientColor: string | null
  projectId: number | null
  isUnassigned: boolean
  sessions: Session[]
  sessionCount: number
  totalDurationMinutes: number
  totalPrompts: number
  totalTokens: number
}

/**
 * Merge overlapping time intervals and return total wall-clock minutes.
 * This represents the actual "human time" spent, counting overlapping
 * sessions (e.g., two projects open simultaneously) only once.
 */
function computeHumanMinutes(sessions: Session[]): number {
  if (sessions.length === 0) return 0

  const intervals = sessions
    .map((s) => ({ start: new Date(s.startedAt).getTime(), end: new Date(s.endedAt).getTime() }))
    .sort((a, b) => a.start - b.start)

  let totalMs = 0
  let curStart = intervals[0].start
  let curEnd = intervals[0].end

  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i].start <= curEnd) {
      // Overlapping — extend current interval
      curEnd = Math.max(curEnd, intervals[i].end)
    } else {
      // Gap — flush current interval
      totalMs += curEnd - curStart
      curStart = intervals[i].start
      curEnd = intervals[i].end
    }
  }
  totalMs += curEnd - curStart

  return Math.round(totalMs / 60_000)
}

export function useSessionStats(
  sessions: Session[] | undefined,
  clients?: Client[],
  sessionIdsWithCommits?: Set<number>
): SessionStats {
  if (!sessions || sessions.length === 0) {
    return {
      humanHours: '0m',
      totalHours: '0m',
      totalSessions: 0,
      totalPrompts: 0,
      totalTokens: 0,
      clientCount: clients?.length ?? 0,
      commitSessions: 0
    }
  }

  const totalMinutes = sessions.reduce((sum, s) => sum + s.durationMinutes, 0)
  const totalPrompts = sessions.reduce((sum, s) => sum + (s.promptCount ?? 0), 0)
  const totalTokens = sessions.reduce(
    (sum, s) => sum + (s.inputTokens ?? 0) + (s.outputTokens ?? 0),
    0
  )
  const humanMinutes = computeHumanMinutes(sessions)

  const commitSessions = sessionIdsWithCommits
    ? sessions.filter((s) => sessionIdsWithCommits.has(s.id)).length
    : 0

  return {
    humanHours: formatDuration(humanMinutes),
    totalHours: formatDuration(totalMinutes),
    totalSessions: sessions.length,
    totalPrompts,
    totalTokens,
    clientCount: clients?.length ?? 0,
    commitSessions
  }
}

export function useGroupedSessions(
  sessions: Session[] | undefined,
  projects?: Project[],
  clients?: Client[],
  presentationMode = false
): ProjectGroup[] {
  if (!sessions || sessions.length === 0) return []

  const projectMap = new Map(projects?.map((p) => [p.id, p]) ?? [])
  const clientMap = new Map(clients?.map((c) => [c.id, c]) ?? [])

  const groups = new Map<
    string,
    { sessions: Session[]; projectId: number | null; clientId: number | null }
  >()

  for (const session of sessions) {
    const key =
      session.projectId != null ? `project:${session.projectId}` : `path:${session.projectPath}`
    const existing = groups.get(key)
    if (existing) {
      existing.sessions.push(session)
    } else {
      groups.set(key, {
        sessions: [session],
        projectId: session.projectId,
        clientId: session.clientId
      })
    }
  }

  const result: ProjectGroup[] = Array.from(groups.entries()).map(([, group]) => {
    const project = group.projectId != null ? projectMap.get(group.projectId) : undefined
    const client = group.clientId != null ? clientMap.get(group.clientId) : undefined

    return {
      projectPath: group.sessions[0].projectPath,
      projectName: resolveProjectName(
        project,
        presentationMode,
        getProjectName(group.sessions[0].projectPath)
      ),
      clientName: client ? resolveClientName(client, presentationMode) : null,
      clientColor: client?.color ?? null,
      projectId: group.projectId,
      isUnassigned: group.projectId == null,
      sessions: group.sessions.sort(
        (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
      ),
      sessionCount: group.sessions.length,
      totalDurationMinutes: group.sessions.reduce((sum, s) => sum + s.durationMinutes, 0),
      totalPrompts: group.sessions.reduce((sum, s) => sum + (s.promptCount ?? 0), 0),
      totalTokens: group.sessions.reduce(
        (sum, s) => sum + (s.inputTokens ?? 0) + (s.outputTokens ?? 0),
        0
      )
    }
  })

  return result.sort((a, b) => {
    // Assigned groups first, unassigned last
    if (a.isUnassigned && !b.isUnassigned) return 1
    if (!a.isUnassigned && b.isUnassigned) return -1
    // Assigned: alphabetical by client name then project name
    if (!a.isUnassigned && !b.isUnassigned) {
      const clientCmp = (a.clientName ?? '').localeCompare(b.clientName ?? '')
      if (clientCmp !== 0) return clientCmp
      return a.projectName.localeCompare(b.projectName)
    }
    // Unassigned: by duration descending
    return b.totalDurationMinutes - a.totalDurationMinutes
  })
}
