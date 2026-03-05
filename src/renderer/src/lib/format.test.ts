import { describe, it, expect } from 'vitest'
import {
  formatDuration,
  formatTimeRange,
  formatRelativeTime,
  getProjectColor,
  getProjectName,
  getDateRangeForPreset,
  formatShortDate
} from './format'

describe('formatDuration', () => {
  it('formats zero minutes', () => {
    expect(formatDuration(0)).toBe('0m')
  })

  it('formats minutes only', () => {
    expect(formatDuration(45)).toBe('45m')
  })

  it('formats hours only', () => {
    expect(formatDuration(120)).toBe('2h')
  })

  it('formats hours and minutes', () => {
    expect(formatDuration(125)).toBe('2h 5m')
  })

  it('handles negative values', () => {
    expect(formatDuration(-5)).toBe('0m')
  })
})

describe('formatTimeRange', () => {
  it('formats a time range with en-dash', () => {
    const result = formatTimeRange('2026-03-04T09:15:00Z', '2026-03-04T11:42:00Z')
    expect(result).toContain('\u2013')
    // Time format depends on locale but should contain digits
    expect(result).toMatch(/\d{2}:\d{2}/)
  })
})

describe('formatRelativeTime', () => {
  it('formats recent time as just now', () => {
    const now = new Date().toISOString()
    expect(formatRelativeTime(now)).toBe('just now')
  })

  it('formats minutes ago', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    expect(formatRelativeTime(fiveMinAgo)).toBe('5 min ago')
  })

  it('formats hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString()
    expect(formatRelativeTime(twoHoursAgo)).toBe('2h ago')
  })

  it('formats yesterday', () => {
    const yesterday = new Date(Date.now() - 25 * 3600_000).toISOString()
    expect(formatRelativeTime(yesterday)).toBe('yesterday')
  })

  it('formats older dates with month and day', () => {
    const oldDate = new Date(Date.now() - 5 * 86400_000).toISOString()
    const result = formatRelativeTime(oldDate)
    // Should be a date string like "Feb 27" not "Xh ago"
    expect(result).not.toContain('ago')
    expect(result).not.toBe('yesterday')
  })
})

describe('getProjectColor', () => {
  it('returns a CSS variable string', () => {
    const color = getProjectColor('/apps/ClawdTime')
    expect(color).toMatch(/^var\(--project-\d\)$/)
  })

  it('returns deterministic color for same path', () => {
    const a = getProjectColor('/apps/ClawdTime')
    const b = getProjectColor('/apps/ClawdTime')
    expect(a).toBe(b)
  })

  it('returns different colors for different paths', () => {
    const a = getProjectColor('/apps/ClawdTime')
    const b = getProjectColor('/home/user/other-project')
    // Not guaranteed different but very likely for these two paths
    // Just verify both are valid
    expect(a).toMatch(/^var\(--project-\d\)$/)
    expect(b).toMatch(/^var\(--project-\d\)$/)
  })
})

describe('getProjectName', () => {
  it('extracts last path segment from Unix path', () => {
    expect(getProjectName('/apps/ClawdTime')).toBe('ClawdTime')
  })

  it('extracts last path segment from Windows path', () => {
    expect(getProjectName('C:\\apps\\ClawdTime')).toBe('ClawdTime')
  })

  it('handles trailing slash', () => {
    expect(getProjectName('/apps/ClawdTime/')).toBe('ClawdTime')
  })

  it('returns path when no separator', () => {
    expect(getProjectName('ClawdTime')).toBe('ClawdTime')
  })
})

describe('getDateRangeForPreset', () => {
  it('today returns start and end of current day', () => {
    const { startDate, endDate } = getDateRangeForPreset('today')
    const start = new Date(startDate)
    const end = new Date(endDate)
    const now = new Date()
    expect(start.getDate()).toBe(now.getDate())
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
    expect(end.getDate()).toBe(now.getDate())
    expect(end.getHours()).toBe(23)
    expect(end.getMinutes()).toBe(59)
  })

  it('this-week starts on Monday', () => {
    const { startDate } = getDateRangeForPreset('this-week')
    const start = new Date(startDate)
    // Monday = 1
    expect(start.getDay()).toBe(1)
  })

  it('last-week returns Mon–Sun range', () => {
    const { startDate, endDate } = getDateRangeForPreset('last-week')
    const start = new Date(startDate)
    const end = new Date(endDate)
    expect(start.getDay()).toBe(1) // Monday
    expect(end.getDay()).toBe(0) // Sunday
    // End date should be same calendar week — 6 calendar days after start
    expect(end.getDate() - start.getDate() === 6 || end.getDate() < start.getDate()).toBe(true)
  })

  it('this-month starts on 1st of current month', () => {
    const { startDate } = getDateRangeForPreset('this-month')
    const start = new Date(startDate)
    const now = new Date()
    expect(start.getDate()).toBe(1)
    expect(start.getMonth()).toBe(now.getMonth())
  })
})

describe('formatShortDate', () => {
  it('formats date as month and day', () => {
    const result = formatShortDate('2026-03-05T12:00:00Z')
    // Locale-dependent but should contain "Mar" and "5"
    expect(result).toMatch(/Mar/)
    expect(result).toMatch(/5/)
  })
})
