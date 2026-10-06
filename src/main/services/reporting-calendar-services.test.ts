// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { clients } from '../db/schema/clients'
import { sessions } from '../db/schema/sessions'
import { appSettings } from '../db/schema/app-settings'
import { adoptInitialWorkspacePolicy } from './workspace-policy'
import { calendarDayRange } from '../../shared/reporting-calendar'
import { reportService } from './report-service'
import { invoiceService } from './invoice-service'

let db: ReturnType<typeof drizzle>
vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('./session-service', () => ({ sessionService: { getReconciliationCases: () => [] } }))
vi.mock('./credential-service', () => ({
  credentialService: { isStripeTestMode: () => false, getApiKey: () => null }
}))
vi.mock('./stripe-service', () => ({ stripeService: {} }))
vi.mock('./ai-service', () => ({
  aiService: { summarizeSessionGroup: vi.fn().mockResolvedValue(null) }
}))
vi.mock('./client-project-service', () => ({
  clientProjectService: {
    getExcludedProjectIds: () => [],
    getClientById: (id: number) => db.select().from(clients).where(eq(clients.id, id)).get()
  }
}))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

it('produces the same reporting day and invoice scope on independent databases with different host zones', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'))
  const results: unknown[] = []
  for (const [index, timeZone] of ['Pacific/Auckland', 'America/Los_Angeles'].entries()) {
    vi.stubEnv('TZ', timeZone)
    const sqlite = new Database(':memory:')
    try {
      db = drizzle(sqlite)
      migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
      db.insert(appSettings)
        .values({ key: 'idle_timeout_minutes', value: index ? '90' : '5' })
        .run()
      adoptInitialWorkspacePolicy(db, {
        workspaceId: '11111111-1111-4111-8111-111111111111',
        revisionId: '22222222-2222-4222-8222-222222222222',
        policy: {
          version: 1,
          normalizationVersion: 1,
          detectorVersion: 1,
          idleTimeoutMinutes: 15,
          reportingTimeZone: 'America/New_York'
        }
      })
      const client = db
        .insert(clients)
        .values({ name: 'Fixture', color: '#fff', billableRate: 120 })
        .returning()
        .get()
      db.insert(sessions)
        .values({
          projectPath: 'fixture',
          clientId: client.id,
          startedAt: '2026-09-27T02:00:00.000Z',
          endedAt: '2026-09-27T02:20:00.000Z',
          durationMinutes: 20,
          promptCount: 2
        })
        .run()
      const report = reportService.generateReport(
        calendarDayRange('2026-09-26', 'America/New_York'),
        'daily-summary'
      )
      const invoice = await invoiceService.generateLineItems(client.id, '2026-09-26', '2026-09-26')
      expect(report.reportingTimeZone).toBe('America/New_York')
      expect(report.summary.totalDurationMinutes).toBe(20)
      expect(report.dailySummary?.[0].date).toContain('26')
      expect(invoice.lineItems).toMatchObject([
        { lineDate: '2026-09-26', amountCents: 4000, durationMinutes: 20 }
      ])
      expect(
        (await invoiceService.generateLineItems(client.id, '2026-09-27', '2026-09-27')).lineItems
      ).toEqual([])
      results.push({ report, invoice })
    } finally {
      sqlite.close()
    }
  }
  expect(results[0]).toEqual(results[1])
})
