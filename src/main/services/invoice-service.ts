import { eq, and, desc, ne, lte, gte } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { sessions } from '../db/schema/sessions'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { clientProjectService } from './client-project-service'
import { stripeService } from './stripe-service'
import { aiService } from './ai-service'
import { AppError } from '../../shared/types/ipc'
import type {
  GeneratedLineItem,
  LocalInvoice,
  LocalInvoiceDetail,
  InvoiceOverlap
} from '../../shared/types/invoice'

/** Format a date string as MM/DD/YY */
function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const yy = String(d.getFullYear()).slice(-2)
  return `${mm}/${dd}/${yy}`
}

/** Extract YYYY-MM-DD from an ISO timestamp */
function toDateKey(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10)
}

export const invoiceService = {
  /**
   * Generate line items from sessions for a client in a date range.
   * Groups by day, computes amounts, generates AI descriptions.
   */
  async generateLineItems(
    clientId: number,
    startDate: string,
    endDate: string
  ): Promise<GeneratedLineItem[]> {
    const client = clientProjectService.getClientById(clientId)
    if (!client) throw new AppError('CLIENT_NOT_FOUND', `Client ${clientId} not found`)
    if (!client.billableRate) {
      throw new AppError('NO_BILLABLE_RATE', 'Client has no billable rate configured')
    }

    const db = getDb()

    // Query sessions for this client in the date range
    const sessionRows = db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.clientId, clientId),
          gte(sessions.startedAt, startDate),
          lte(sessions.startedAt, endDate + 'T23:59:59.999Z'),
          eq(sessions.status, 'completed')
        )
      )
      .orderBy(sessions.startedAt)
      .all()

    if (sessionRows.length === 0) return []

    // Load project names
    const projectRows = db.select().from(projects).all()
    const projectMap = new Map(projectRows.map((p) => [p.id, p.name]))

    // Group sessions by calendar day
    const dayGroups = new Map<
      string,
      { sessions: typeof sessionRows; totalMinutes: number; projectSessions: Map<string, typeof sessionRows> }
    >()

    for (const session of sessionRows) {
      const dateKey = toDateKey(session.startedAt)
      if (!dayGroups.has(dateKey)) {
        dayGroups.set(dateKey, { sessions: [], totalMinutes: 0, projectSessions: new Map() })
      }
      const group = dayGroups.get(dateKey)!
      group.sessions.push(session)
      group.totalMinutes += session.durationMinutes

      const projectName = session.projectId ? projectMap.get(session.projectId) ?? 'Unknown' : 'Unknown'
      if (!group.projectSessions.has(projectName)) {
        group.projectSessions.set(projectName, [])
      }
      group.projectSessions.get(projectName)!.push(session)
    }

    // Generate line items per day
    const lineItems: GeneratedLineItem[] = []
    const sortedDays = Array.from(dayGroups.keys()).sort()

    for (const dateKey of sortedDays) {
      const group = dayGroups.get(dateKey)!
      const hours = group.totalMinutes / 60
      const amountCents = Math.round(hours * client.billableRate! * 100)
      const sessionIds = group.sessions.map((s) => s.id)
      const projectNames = Array.from(group.projectSessions.keys())
      const dateFormatted = formatDateShort(dateKey)

      // Try AI description for this day
      let description = ''
      try {
        const aiSummary = await aiService.generateReportSummary(
          { startDate: dateKey, endDate: dateKey, clientId },
          true,
          { includeOverall: true, includeDailyBreakdown: false, brief: true }
        )
        if (aiSummary) {
          // Prefix with date and project names
          const projectPrefix = projectNames.join(', ')
          description = `${dateFormatted} ${projectPrefix}: ${aiSummary.trim()}`
        }
      } catch (err) {
        log.warn(`AI description failed for ${dateKey}, using fallback:`, err)
      }

      // Fallback if AI unavailable
      if (!description) {
        const parts = projectNames.map((pn) => {
          const count = group.projectSessions.get(pn)!.length
          return `${pn}: Development work (${count} session${count > 1 ? 's' : ''}, ${hours.toFixed(1)}h)`
        })
        description = `${dateFormatted} ${parts.join('; ')}`
      }

      lineItems.push({
        lineDate: dateKey,
        description,
        amountCents,
        durationMinutes: group.totalMinutes,
        sessionIds,
        projectNames
      })
    }

    return lineItems
  },

  /**
   * Save a sent invoice and its line items to the local DB.
   */
  saveInvoice(data: {
    clientId: number
    stripeInvoiceId: string
    status: string
    amountDueCents: number
    amountPaidCents: number
    currency: string
    memo?: string | null
    hostedUrl?: string | null
    dueDate?: string | null
    paidAt?: string | null
    periodStart?: string | null
    periodEnd?: string | null
    lineItems: Array<{
      lineDate?: string | null
      description: string
      amountCents: number
      durationMinutes?: number | null
      sessionIds?: number[] | null
      sortOrder: number
    }>
  }): number {
    const db = getDb()
    const now = new Date().toISOString()

    const invoice = db
      .insert(invoices)
      .values({
        clientId: data.clientId,
        stripeInvoiceId: data.stripeInvoiceId,
        status: data.status as 'draft' | 'open' | 'paid' | 'void' | 'uncollectible',
        amountDueCents: data.amountDueCents,
        amountPaidCents: data.amountPaidCents,
        currency: data.currency,
        memo: data.memo ?? null,
        hostedUrl: data.hostedUrl ?? null,
        dueDate: data.dueDate ?? null,
        paidAt: data.paidAt ?? null,
        periodStart: data.periodStart ?? null,
        periodEnd: data.periodEnd ?? null,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .get()

    for (const item of data.lineItems) {
      db.insert(invoiceLineItems)
        .values({
          invoiceId: invoice.id,
          lineDate: item.lineDate ?? null,
          description: item.description,
          amountCents: item.amountCents,
          durationMinutes: item.durationMinutes ?? null,
          sessionIds: item.sessionIds ? item.sessionIds.join(',') : null,
          sortOrder: item.sortOrder,
          createdAt: now
        })
        .run()
    }

    log.info(`Saved invoice locally: id=${invoice.id}, stripe=${data.stripeInvoiceId}`)
    return invoice.id
  },

  /**
   * Get all local invoices, optionally filtered.
   */
  getAll(filters?: { clientId?: number; status?: string }): LocalInvoice[] {
    const db = getDb()
    const conditions: ReturnType<typeof eq>[] = []

    if (filters?.clientId != null) {
      conditions.push(eq(invoices.clientId, filters.clientId))
    }
    if (filters?.status) {
      conditions.push(eq(invoices.status, filters.status as 'draft' | 'open' | 'paid' | 'void' | 'uncollectible'))
    }

    const rows = conditions.length > 0
      ? db.select().from(invoices).where(and(...conditions)).orderBy(desc(invoices.createdAt)).all()
      : db.select().from(invoices).orderBy(desc(invoices.createdAt)).all()

    // Join client names
    const clientRows = db.select().from(clients).all()
    const clientMap = new Map(clientRows.map((c) => [c.id, c.name]))

    return rows.map((row) => ({
      id: row.id,
      clientId: row.clientId,
      clientName: clientMap.get(row.clientId) ?? 'Unknown',
      stripeInvoiceId: row.stripeInvoiceId,
      status: row.status as LocalInvoice['status'],
      amountDueCents: row.amountDueCents,
      amountPaidCents: row.amountPaidCents,
      currency: row.currency,
      memo: row.memo,
      hostedUrl: row.hostedUrl,
      dueDate: row.dueDate,
      paidAt: row.paidAt,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      createdAt: row.createdAt
    }))
  },

  /**
   * Get a single invoice with its line items.
   */
  getById(localId: number): LocalInvoiceDetail | null {
    const db = getDb()
    const row = db.select().from(invoices).where(eq(invoices.id, localId)).get()
    if (!row) return null

    const clientRow = db.select().from(clients).where(eq(clients.id, row.clientId)).get()
    const items = db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, localId))
      .orderBy(invoiceLineItems.sortOrder)
      .all()

    return {
      id: row.id,
      clientId: row.clientId,
      clientName: clientRow?.name ?? 'Unknown',
      stripeInvoiceId: row.stripeInvoiceId,
      status: row.status as LocalInvoice['status'],
      amountDueCents: row.amountDueCents,
      amountPaidCents: row.amountPaidCents,
      currency: row.currency,
      memo: row.memo,
      hostedUrl: row.hostedUrl,
      dueDate: row.dueDate,
      paidAt: row.paidAt,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      createdAt: row.createdAt,
      lineItems: items.map((item) => ({
        id: item.id,
        lineDate: item.lineDate,
        description: item.description,
        amountCents: item.amountCents,
        durationMinutes: item.durationMinutes,
        sessionIds: item.sessionIds ? item.sessionIds.split(',').map(Number) : null,
        sortOrder: item.sortOrder
      }))
    }
  },

  /**
   * Sync a single invoice's status from Stripe.
   */
  async syncStatus(localId: number): Promise<LocalInvoice> {
    const db = getDb()
    const row = db.select().from(invoices).where(eq(invoices.id, localId)).get()
    if (!row) throw new AppError('INVOICE_NOT_FOUND', `Invoice ${localId} not found`)

    const stripeStatus = await stripeService.getInvoiceStatus(row.stripeInvoiceId)

    db.update(invoices)
      .set({
        status: stripeStatus.status,
        amountDueCents: stripeStatus.amountDueCents,
        amountPaidCents: stripeStatus.amountPaidCents,
        hostedUrl: stripeStatus.hostedUrl,
        dueDate: stripeStatus.dueDate,
        paidAt: stripeStatus.paidAt,
        updatedAt: new Date().toISOString()
      })
      .where(eq(invoices.id, localId))
      .run()

    const all = this.getAll()
    return all.find((inv) => inv.id === localId)!
  },

  /**
   * Sync all non-terminal invoices from Stripe. Returns count updated.
   */
  async syncAllStatuses(): Promise<number> {
    const db = getDb()
    const openInvoices = db
      .select()
      .from(invoices)
      .where(
        and(
          ne(invoices.status, 'paid'),
          ne(invoices.status, 'void'),
          ne(invoices.status, 'uncollectible')
        )
      )
      .all()

    let updated = 0
    // Rate limit: max 20 per batch
    const batch = openInvoices.slice(0, 20)
    for (const inv of batch) {
      try {
        const stripeStatus = await stripeService.getInvoiceStatus(inv.stripeInvoiceId)
        if (stripeStatus.status !== inv.status) {
          db.update(invoices)
            .set({
              status: stripeStatus.status,
              amountDueCents: stripeStatus.amountDueCents,
              amountPaidCents: stripeStatus.amountPaidCents,
              hostedUrl: stripeStatus.hostedUrl,
              dueDate: stripeStatus.dueDate,
              paidAt: stripeStatus.paidAt,
              updatedAt: new Date().toISOString()
            })
            .where(eq(invoices.id, inv.id))
            .run()
          updated++
        }
      } catch (err) {
        log.warn(`Failed to sync invoice ${inv.stripeInvoiceId}:`, err)
      }
    }

    log.info(`Synced ${updated}/${batch.length} invoice statuses`)
    return updated
  },

  /**
   * Check for overlapping invoices for a client in a date range.
   */
  checkOverlap(clientId: number, startDate: string, endDate: string): InvoiceOverlap[] {
    const db = getDb()
    const rows = db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.clientId, clientId),
          ne(invoices.status, 'void'),
          lte(invoices.periodStart, endDate),
          gte(invoices.periodEnd, startDate)
        )
      )
      .all()

    return rows
      .filter((r) => r.periodStart && r.periodEnd)
      .map((r) => ({
        invoiceId: r.id,
        stripeInvoiceId: r.stripeInvoiceId,
        periodStart: r.periodStart!,
        periodEnd: r.periodEnd!,
        amountDueCents: r.amountDueCents,
        createdAt: r.createdAt
      }))
  }
}
