import { afterEach, expect, it, vi } from 'vitest'
import { calendarDate, calendarDateKey, calendarDayRange } from './reporting-calendar'
import { getDateRangeForPreset, formatDateLabel, formatTimeRange } from '../renderer/src/lib/format'

afterEach(() => vi.useRealTimers())

it('uses the workspace day and clock independently of the host calendar', () => {
  const instant = '2026-09-27T02:00:00.000Z'
  expect(calendarDateKey(instant, 'America/New_York')).toBe('2026-09-26')
  expect(calendarDateKey(instant, 'Pacific/Auckland')).toBe('2026-09-27')
  expect(calendarDate(instant, 'America/New_York').getHours()).toBe(22)
  expect(formatTimeRange(instant, '2026-09-27T02:10:00.000Z', 'America/New_York')).toContain(
    '22:00'
  )
})

it.each([
  ['2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.999Z'],
  ['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T04:59:59.999Z']
])('uses actual daylight-saving boundaries for %s', (date, startDate, endDate) => {
  expect(calendarDayRange(date, 'America/New_York')).toEqual({ startDate, endDate })
})

it('computes today and the current month in the reporting timezone', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-01T02:00:00.000Z'))
  expect(getDateRangeForPreset('today', 1, 'America/New_York')).toEqual({
    startDate: '2026-09-30T04:00:00.000Z',
    endDate: '2026-10-01T03:59:59.999Z'
  })
  expect(getDateRangeForPreset('this-month', 1, 'America/New_York').startDate).toBe(
    '2026-09-01T04:00:00.000Z'
  )
  expect(formatDateLabel('2026-09-30T23:00:00Z', 'America/New_York')).toBe('Today')
  expect(formatDateLabel('2026-09-29T23:00:00Z', 'America/New_York')).toBe('Yesterday')
})
