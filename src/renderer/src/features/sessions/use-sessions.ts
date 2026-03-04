import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Session, SessionFilters, ScanResult } from '../../../../shared/types/session'
import { formatDuration, getProjectName } from '@/lib/format'

async function fetchSessions(filters?: SessionFilters): Promise<Session[]> {
  const result = await window.api.sessions.getAll(filters)
  if (!result.success) throw new Error(result.error.message)
  return result.data
}

async function scanSessions(): Promise<ScanResult> {
  const result = await window.api.sessions.scan()
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
    mutationFn: scanSessions,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    }
  })
}

export interface SessionStats {
  todayTotal: string
  activeSessions: number
  totalSessions: number
  tokensUsed: number
}

export interface ProjectGroup {
  projectPath: string
  projectName: string
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

export function useSessionStats(sessions: Session[] | undefined): SessionStats {
  if (!sessions || sessions.length === 0) {
    return { todayTotal: '0m', activeSessions: 0, totalSessions: 0, tokensUsed: 0 }
  }

  const todayMinutes = sessions
    .filter((s) => isToday(s.startedAt))
    .reduce((sum, s) => sum + s.durationMinutes, 0)

  return {
    todayTotal: formatDuration(todayMinutes),
    activeSessions: 0, // Placeholder until live sessions
    totalSessions: sessions.length,
    tokensUsed: 0 // Placeholder until token tracking (Epic 6)
  }
}

export function useGroupedSessions(sessions: Session[] | undefined): ProjectGroup[] {
  if (!sessions || sessions.length === 0) return []

  const groups = new Map<string, Session[]>()
  for (const session of sessions) {
    const existing = groups.get(session.projectPath) ?? []
    existing.push(session)
    groups.set(session.projectPath, existing)
  }

  return Array.from(groups.entries())
    .map(([projectPath, groupSessions]) => ({
      projectPath,
      projectName: getProjectName(projectPath),
      sessions: groupSessions.sort(
        (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
      ),
      sessionCount: groupSessions.length,
      totalDurationMinutes: groupSessions.reduce((sum, s) => sum + s.durationMinutes, 0)
    }))
    .sort((a, b) => b.totalDurationMinutes - a.totalDurationMinutes)
}
