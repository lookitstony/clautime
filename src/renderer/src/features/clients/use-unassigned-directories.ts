import { useMemo } from 'react'
import { useSessions } from '../sessions/use-sessions'
import { useProjects } from './use-projects'
import { useClients } from './use-clients'
import { getProjectName } from '@/lib/format'

export interface UnassignedDirectory {
  path: string
  name: string
  sessionCount: number
}

function normalizePath(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase()
}

export function useUnassignedDirectories(): UnassignedDirectory[] {
  const { data: sessions } = useSessions()
  const { data: allProjects } = useProjects()
  const { data: allClients } = useClients()

  return useMemo(() => {
    if (!sessions || sessions.length === 0) return []

    // Find the "Unassigned" client ID so we treat its projects as reassignable
    const unassignedClientId = allClients?.find((c) => c.name === 'Unassigned')?.id

    // Collect assigned directory paths — exclude projects under "Unassigned" client
    const assignedPaths = new Set(
      (allProjects ?? [])
        .filter((p) => p.clientId !== unassignedClientId)
        .map((p) => normalizePath(p.directoryPath))
    )

    // Group sessions by normalized path, keep original path from first occurrence
    const dirMap = new Map<string, { path: string; count: number }>()
    for (const s of sessions) {
      const norm = normalizePath(s.projectPath)
      if (assignedPaths.has(norm)) continue
      const existing = dirMap.get(norm)
      if (existing) {
        existing.count++
      } else {
        dirMap.set(norm, { path: s.projectPath, count: 1 })
      }
    }

    return Array.from(dirMap.values())
      .map((d) => ({
        path: d.path,
        name: getProjectName(d.path),
        sessionCount: d.count
      }))
      .sort((a, b) => b.sessionCount - a.sessionCount)
  }, [sessions, allProjects, allClients])
}
