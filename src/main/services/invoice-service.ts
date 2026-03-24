import { eq, and, desc, ne, lte, gte } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { sessions } from '../db/schema/sessions'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { gitCommits } from '../db/schema/git-commits'
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

/** Format a date string (YYYY-MM-DD) as MM/DD/YY */
function formatDateShort(dateStr: string): string {
  // Parse YYYY-MM-DD directly to avoid UTC→local shift
  const [y, m, d] = dateStr.split('-')
  return `${m}/${d}/${y.slice(-2)}`
}

/** Extract YYYY-MM-DD from an ISO timestamp in LOCAL time */
function toDateKey(isoTimestamp: string): string {
  const d = new Date(isoTimestamp)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const invoiceService = {
  /**
   * Generate line items from sessions for a client in a date range.
   * Groups by day, computes amounts, generates AI descriptions.
   */
  async generateLineItems(
    clientId: number,
    startDate: string,
    endDate: string,
    projectId?: number
  ): Promise<GeneratedLineItem[]> {
    const client = clientProjectService.getClientById(clientId)
    if (!client) throw new AppError('CLIENT_NOT_FOUND', `Client ${clientId} not found`)
    if (!client.billableRate) {
      throw new AppError('NO_BILLABLE_RATE', 'Client has no billable rate configured')
    }

    const db = getDb()

    // Query sessions for this client — fetch all completed, then filter by local date
    const conditions = [
      eq(sessions.clientId, clientId),
      eq(sessions.status, 'completed')
    ]
    if (projectId != null) {
      conditions.push(eq(sessions.projectId, projectId))
    }

    const allRows = db
      .select()
      .from(sessions)
      .where(and(...conditions))
      .orderBy(sessions.startedAt)
      .all()

    // Filter by local date to handle UTC→local timezone differences
    const sessionRows = allRows.filter((s) => {
      const localDate = toDateKey(s.startedAt)
      return localDate >= startDate && localDate <= endDate
    })

    log.info(`Invoice generateLineItems: ${allRows.length} total sessions for client, ${sessionRows.length} in ${startDate} to ${endDate}`)
    if (sessionRows.length > 0) {
      const dates = [...new Set(sessionRows.map((s) => toDateKey(s.startedAt)))].sort()
      log.info(`Invoice date range found: ${dates[0]} to ${dates[dates.length - 1]} (${dates.length} days)`)
    }

    if (sessionRows.length === 0) return []

    // Load project names
    const projectRows = db.select().from(projects).all()
    const projectMap = new Map(projectRows.map((p) => [p.id, p.invoiceName ?? p.name]))

    // Group sessions by calendar day + project for separate line items
    const groupKey = (dateKey: string, projId: number | null) => `${dateKey}::${projId ?? 0}`
    const dayProjectGroups = new Map<
      string,
      { dateKey: string; projectId: number | null; projectName: string; sessions: typeof sessionRows; totalMinutes: number }
    >()

    for (const session of sessionRows) {
      const dateKey = toDateKey(session.startedAt)
      const key = groupKey(dateKey, session.projectId)
      if (!dayProjectGroups.has(key)) {
        const projectName = session.projectId ? projectMap.get(session.projectId) ?? 'Unknown' : 'Unknown'
        dayProjectGroups.set(key, { dateKey, projectId: session.projectId, projectName, sessions: [], totalMinutes: 0 })
      }
      const group = dayProjectGroups.get(key)!
      group.sessions.push(session)
      group.totalMinutes += session.durationMinutes
    }

    // ── Attribute commits to session days (same logic as reports) ──
    // For each unique projectId, get all commits and build commit-span attribution.
    // Result: commitsByDayProject maps "dateKey::projectId" → commit messages for that day.
    const commitsByDayProject = new Map<string, string[]>()
    const uniqueProjectIds = [...new Set(
      Array.from(dayProjectGroups.values())
        .map((g) => g.projectId)
        .filter((id): id is number => id != null)
    )]

    for (const projId of uniqueProjectIds) {
      // Get all commits for this project, sorted
      const allCommits = db.select().from(gitCommits)
        .where(eq(gitCommits.projectId, projId))
        .orderBy(gitCommits.committedAt)
        .all()

      if (allCommits.length === 0) continue

      // Build commit date key lookup
      const commitsByDateKey = new Map<string, string[]>()
      for (const c of allCommits) {
        const dk = toDateKey(c.committedAt)
        if (!commitsByDateKey.has(dk)) commitsByDateKey.set(dk, [])
        const msgs = commitsByDateKey.get(dk)!
        if (!msgs.includes(c.message)) msgs.push(c.message)
      }
      const commitDateKeys = Array.from(commitsByDateKey.keys()).sort()

      // Get session days for this project
      const sessionDays = [...new Set(
        Array.from(dayProjectGroups.values())
          .filter((g) => g.projectId === projId)
          .map((g) => g.dateKey)
      )].sort()

      // Map each session day → next commit date on or after
      const commitSpans = new Map<string, string[]>() // commitDateKey → session days
      for (const day of sessionDays) {
        const nextCommitDate = commitDateKeys.find((ck) => ck >= day)
        if (nextCommitDate) {
          if (!commitSpans.has(nextCommitDate)) commitSpans.set(nextCommitDate, [])
          commitSpans.get(nextCommitDate)!.push(day)
        }
      }

      // Spread commit messages evenly across the session days in each span
      for (const [commitDate, spanDays] of commitSpans) {
        const msgs = commitsByDateKey.get(commitDate)!
        spanDays.sort()
        const numDays = spanDays.length
        const perDay = Math.max(1, Math.ceil(msgs.length / numDays))

        for (let i = 0; i < numDays; i++) {
          const slice = msgs.slice(i * perDay, (i + 1) * perDay)
          // If no items left for this day, carry forward the last message
          const items = slice.length > 0 ? slice : [msgs[msgs.length - 1]]
          const key = `${spanDays[i]}::${projId}`
          const existing = commitsByDayProject.get(key) ?? []
          for (const m of items) {
            if (!existing.includes(m)) existing.push(m)
          }
          commitsByDayProject.set(key, existing)
        }
      }
    }

    // Generate line items per day+project
    const lineItems: GeneratedLineItem[] = []
    const sortedGroups = Array.from(dayProjectGroups.values()).sort(
      (a, b) => a.dateKey.localeCompare(b.dateKey) || a.projectName.localeCompare(b.projectName)
    )

    for (const group of sortedGroups) {
      const hours = group.totalMinutes / 60
      const amountCents = Math.round(hours * client.billableRate! * 100)
      const sessionIds = group.sessions.map((s) => s.id)
      const dateFormatted = formatDateShort(group.dateKey)

      // Get the attributed commit messages for this day+project
      const dayCommitMsgs = commitsByDayProject.get(`${group.dateKey}::${group.projectId ?? 0}`) ?? []

      // Try AI description
      let description = ''
      try {
        const result = await aiService.summarizeSessionGroup(sessionIds, group.projectName, dayCommitMsgs)
        if (result && result.lines.length > 0) {
          const header = `${dateFormatted} ${group.projectName}:`
          if (result.lines.length === 1) {
            const line = result.lines[0]
            const ticketPart = line.ticket ? `${line.ticket}: ` : ''
            description = `${header} ${ticketPart}${line.description}`
          } else {
            // Multiple tickets — each on its own line, indented under the header
            const ticketLines = result.lines.map((line) => {
              const ticketPart = line.ticket ? `${line.ticket}: ` : ''
              return `  ${ticketPart}${line.description}`
            })
            description = `${header}\n${ticketLines.join('\n')}`
          }
        }
      } catch (err) {
        log.warn(`AI description failed for ${group.dateKey}/${group.projectName}, using fallback:`, err)
      }

      // Fallback if AI unavailable
      if (!description) {
        const count = group.sessions.length
        description = `${dateFormatted} ${group.projectName}: Development work (${count} session${count > 1 ? 's' : ''}, ${hours.toFixed(1)}h)`
      }

      lineItems.push({
        lineDate: group.dateKey,
        description,
        amountCents,
        durationMinutes: group.totalMinutes,
        sessionIds,
        projectNames: [group.projectName]
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
