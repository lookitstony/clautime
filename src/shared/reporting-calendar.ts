import { TZDate } from '@date-fns/tz'

/** Calendar operations use the workspace zone; standalone installations keep local time. */
export function calendarDate(value: string | number | Date, timeZone?: string): Date {
  return timeZone ? new TZDate(new Date(value).getTime(), timeZone) : new Date(value)
}

export function calendarDayStart(
  year: number,
  month: number,
  day: number,
  timeZone?: string
): Date {
  const date = timeZone
    ? new TZDate(year, month, day, 0, 0, 0, 0, timeZone)
    : new Date(year, month, day)
  return new Date(date.getTime())
}

export function calendarDateKey(value: string | number | Date, timeZone?: string): string {
  const date = calendarDate(value, timeZone)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function calendarDayRange(
  dateKey: string,
  timeZone?: string
): { startDate: string; endDate: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('A calendar date is required')
  const [year, month, day] = dateKey.split('-').map(Number)
  const start = calendarDayStart(year, month - 1, day, timeZone)
  const end = calendarDayStart(year, month - 1, day + 1, timeZone)
  return { startDate: start.toISOString(), endDate: new Date(end.getTime() - 1).toISOString() }
}
