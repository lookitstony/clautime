import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useUnassignedDirectories } from './use-unassigned-directories'

vi.mock('../sessions/use-sessions', () => ({
  useSessions: vi.fn()
}))

vi.mock('./use-projects', () => ({
  useProjects: vi.fn()
}))

import { useSessions } from '../sessions/use-sessions'
import { useProjects } from './use-projects'

const mockUseSessions = vi.mocked(useSessions)
const mockUseProjects = vi.mocked(useProjects)

function mockQuery<T>(data: T | undefined) {
  return { data, isLoading: false, error: null } as ReturnType<typeof useSessions>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useUnassignedDirectories', () => {
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
      mockQuery([{ directoryPath: 'C:\\apps\\ClauTime' }]) as any
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

  it('matches projects case-insensitively with backslash normalization', () => {
    mockUseSessions.mockReturnValue(
      mockQuery([{ projectPath: 'C:/Apps/ClauTime' }]) as any
    )
    mockUseProjects.mockReturnValue(
      mockQuery([{ directoryPath: 'c:\\apps\\clautime' }]) as any
    )
    const { result } = renderHook(() => useUnassignedDirectories())
    expect(result.current).toHaveLength(0)
  })
})
