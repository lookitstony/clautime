import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useUnassignedDirectories } from './use-unassigned-directories'

vi.mock('../sessions/use-sessions', () => ({
  useSessions: vi.fn()
}))

vi.mock('./use-projects', () => ({
  useProjects: vi.fn()
}))

vi.mock('./use-clients', () => ({
  useClients: vi.fn()
}))

import { useSessions } from '../sessions/use-sessions'
import { useProjects } from './use-projects'
import { useClients } from './use-clients'

const mockUseSessions = vi.mocked(useSessions)
const mockUseProjects = vi.mocked(useProjects)
const mockUseClients = vi.mocked(useClients)

function mockQuery<T>(data: T | undefined) {
  return { data, isLoading: false, error: null } as ReturnType<typeof useSessions>
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseClients.mockReturnValue(mockQuery([]) as any)
})

describe('useUnassignedDirectories', () => {
  it('keeps already assigned history out of unassigned folders after a move or disconnect', () => {
    mockUseSessions.mockReturnValue(
      mockQuery([
        { projectPath: 'C:/old', projectId: 1 },
        { projectPath: 'D:/other', projectId: 2 },
        { projectPath: 'C:/old', projectId: null }
      ]) as any
    )
    mockUseProjects.mockReturnValue(
      mockQuery([
        { id: 1, clientId: 1, directoryPath: 'C:/new' },
        { id: 2, clientId: 1, directoryPath: null }
      ]) as any
    )
    const { result } = renderHook(() => useUnassignedDirectories())
    expect(result.current).toEqual([{ path: 'C:/old', name: 'old', sessionCount: 1 }])
  })

  it('returns empty array when no sessions', () => {
    mockUseSessions.mockReturnValue(mockQuery([]) as any)
    mockUseProjects.mockReturnValue(mockQuery([]) as any)
    const { result } = renderHook(() => useUnassignedDirectories())
    expect(result.current).toEqual([])
  })

  it('returns empty array when sessions is undefined', () => {
    mockUseSessions.mockReturnValue(mockQuery(undefined) as any)
    mockUseProjects.mockReturnValue(mockQuery([]) as any)
    const { result } = renderHook(() => useUnassignedDirectories())
    expect(result.current).toEqual([])
  })

  it('returns directories from sessions not matched by any project', () => {
    mockUseSessions.mockReturnValue(
      mockQuery([
        { projectPath: 'C:\\apps\\ClauTime' },
        { projectPath: 'C:\\apps\\OtherApp' }
      ]) as any
    )
    mockUseProjects.mockReturnValue(mockQuery([]) as any)
    const { result } = renderHook(() => useUnassignedDirectories())
    expect(result.current).toHaveLength(2)
    expect(result.current[0].name).toBe('ClauTime')
    expect(result.current[1].name).toBe('OtherApp')
  })

  it('excludes directories already assigned to a project', () => {
    mockUseSessions.mockReturnValue(
      mockQuery([
        { projectPath: 'C:\\apps\\ClauTime' },
        { projectPath: 'C:\\apps\\OtherApp' }
      ]) as any
    )
    mockUseProjects.mockReturnValue(
      mockQuery([{ directoryPath: 'C:\\apps\\ClauTime', clientId: 1 }]) as any
    )
    const { result } = renderHook(() => useUnassignedDirectories())
    expect(result.current).toHaveLength(1)
    expect(result.current[0].name).toBe('OtherApp')
  })

  it('deduplicates by normalized path (case-insensitive)', () => {
    mockUseSessions.mockReturnValue(
      mockQuery([
        { projectPath: 'C:\\Apps\\ClauTime' },
        { projectPath: 'c:\\apps\\clautime' }
      ]) as any
    )
    mockUseProjects.mockReturnValue(mockQuery([]) as any)
    const { result } = renderHook(() => useUnassignedDirectories())
    expect(result.current).toHaveLength(1)
    expect(result.current[0].sessionCount).toBe(2)
  })

  it('counts sessions per directory', () => {
    mockUseSessions.mockReturnValue(
      mockQuery([
        { projectPath: 'C:\\apps\\A' },
        { projectPath: 'C:\\apps\\A' },
        { projectPath: 'C:\\apps\\A' },
        { projectPath: 'C:\\apps\\B' }
      ]) as any
    )
    mockUseProjects.mockReturnValue(mockQuery([]) as any)
    const { result } = renderHook(() => useUnassignedDirectories())
    expect(result.current[0].path).toBe('C:\\apps\\A')
    expect(result.current[0].sessionCount).toBe(3)
    expect(result.current[1].sessionCount).toBe(1)
  })

  it('sorts by session count descending', () => {
    mockUseSessions.mockReturnValue(
      mockQuery([
        { projectPath: 'C:\\apps\\Few' },
        { projectPath: 'C:\\apps\\Many' },
        { projectPath: 'C:\\apps\\Many' },
        { projectPath: 'C:\\apps\\Many' }
      ]) as any
    )
    mockUseProjects.mockReturnValue(mockQuery([]) as any)
    const { result } = renderHook(() => useUnassignedDirectories())
    expect(result.current[0].name).toBe('Many')
    expect(result.current[1].name).toBe('Few')
  })

  it('treats a renamed built-in Unassigned client by role, not by name', () => {
    mockUseSessions.mockReturnValue(
      mockQuery([
        { projectPath: 'C:/inbox', projectId: 1 },
        { projectPath: 'C:/real', projectId: 2 }
      ]) as any
    )
    mockUseProjects.mockReturnValue(
      mockQuery([
        { id: 1, clientId: 7, directoryPath: 'C:/inbox' },
        { id: 2, clientId: 8, directoryPath: 'C:/real' }
      ]) as any
    )
    mockUseClients.mockReturnValue(
      mockQuery([
        { id: 7, name: 'Inbox', systemRole: 'unassigned' },
        // A user client that merely has the old built-in name is an ordinary client.
        { id: 8, name: 'Unassigned', systemRole: null }
      ]) as any
    )
    const { result } = renderHook(() => useUnassignedDirectories())
    expect(result.current).toEqual([{ path: 'C:/inbox', name: 'inbox', sessionCount: 1 }])
  })

  it('falls back to the name only for older client payloads without a role', () => {
    mockUseSessions.mockReturnValue(mockQuery([{ projectPath: 'C:/inbox', projectId: 1 }]) as any)
    mockUseProjects.mockReturnValue(
      mockQuery([{ id: 1, clientId: 7, directoryPath: 'C:/inbox' }]) as any
    )
    mockUseClients.mockReturnValue(mockQuery([{ id: 7, name: 'Unassigned' }]) as any)
    const { result } = renderHook(() => useUnassignedDirectories())
    expect(result.current).toHaveLength(1)
  })

  it('matches projects case-insensitively with backslash normalization', () => {
    mockUseSessions.mockReturnValue(mockQuery([{ projectPath: 'C:/Apps/ClauTime' }]) as any)
    mockUseProjects.mockReturnValue(
      mockQuery([{ directoryPath: 'c:\\apps\\clautime', clientId: 1 }]) as any
    )
    const { result } = renderHook(() => useUnassignedDirectories())
    expect(result.current).toHaveLength(0)
  })
})
