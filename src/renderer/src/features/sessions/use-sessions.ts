import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { Session, SessionFilters, ScanResult } from '../../../../shared/types/session'
import type { Client, Project } from '../../../../shared/types/client-project'
import { formatDuration, getProjectName } from '@/lib/format'

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

export function useSessions(filters?: SessionFilters) {
  return useQuery({
    queryKey: ['sessions', 'list', filters],
    queryFn: () => fetchSessions(filters)
  })
}

export function useScanSessions() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (projectFilter?: string[]) => scanSessions(projectFilter),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      const parts: string[] = [`${result.newSessions} sessions found`]
      if (result.attributedCount > 0) {
        parts.push(`${result.attributedCount} attributed`)
      }
      toast.success(`Scan complete: ${parts.join(', ')}`)
    }
  })
}

export interface SessionStats {
  todayTotal: string
  activeSessions: number
  totalSessions: number
  tokensUsed: number
  clientCount: number
  projectCount: number
  unassignedCount: number
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
}

function isToday(isoString: string): boolean {
  const date = new Date(isoString)
  const now = new Date()
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  )
}

export function useSessionStats(
  sessions: Session[] | undefined,
  clients?: Client[],
  projects?: Project[]
): SessionStats {
  if (!sessions || sessions.length === 0) {
    return {
      todayTotal: '0m',
      activeSessions: 0,
      totalSessions: 0,
      tokensUsed: 0,
      clientCount: clients?.length ?? 0,
      projectCount: projects?.length ?? 0,
      unassignedCount: 0
    }
  }

  const todayMinutes = sessions
    .filter((s) => isToday(s.startedAt))
    .reduce((sum, s) => sum + s.durationMinutes, 0)

  const unassignedCount = sessions.filter((s) => s.projectId == null).length

  return {
    todayTotal: formatDuration(todayMinutes),
    activeSessions: 0, // Placeholder until live sessions
    totalSessions: sessions.length,
    tokensUsed: 0, // Placeholder until token tracking (Epic 6)
    clientCount: clients?.length ?? 0,
    projectCount: projects?.length ?? 0,
    unassignedCount
  }
}

export function useGroupedSessions(
  sessions: Session[] | undefined,
  projects?: Project[],
  clients?: Client[]
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
      session.projectId != null
        ? `project:${session.projectId}`
        : `path:${session.projectPath}`
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
    const project =
      group.projectId != null ? projectMap.get(group.projectId) : undefined
    const client =
      group.clientId != null ? clientMap.get(group.clientId) : undefined

    return {
      projectPath: group.sessions[0].projectPath,
      projectName: project?.name ?? getProjectName(group.sessions[0].projectPath),
      clientName: client?.name ?? null,
      clientColor: client?.color ?? null,
      projectId: group.projectId,
      isUnassigned: group.projectId == null,
      sessions: group.sessions.sort(
        (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
      ),
      sessionCount: group.sessions.length,
      totalDurationMinutes: group.sessions.reduce(
        (sum, s) => sum + s.durationMinutes,
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
