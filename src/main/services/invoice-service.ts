import { eq, and, desc, ne, lte, gte } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { sessions } from '../db/schema/sessions'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { gitCommits } from '../db/schema/git-commits'
import { clientProjectService } from './client-project-service'
import { credentialService } from './credential-service'
import { settingsService } from './settings-service'
import { stripeService } from './stripe-service'
import { aiService } from './ai-service'
import { AppError } from '../../shared/types/ipc'
import { clientAlias } from '../../shared/presentation-alias'
import {
  INVOICE_STATUSES,
  type GeneratedLineItem,
  type GenerateLineItemsResult,
  type InvoiceStatus,
  type LocalInvoice,
  type LocalInvoiceDetail,
  type InvoiceOverlap
} from '../../shared/types/invoice'

/** Map a Stripe Invoice object to local saveInvoice format */
function mapStripeInvoiceToLocal(
  inv: import('stripe').Stripe.Invoice,
  clientId: number,
  isTest: boolean
) {
  const status = INVOICE_STATUSES.has(inv.status as InvoiceStatus['status'])
    ? (inv.status as 'draft' | 'open' | 'paid' | 'void' | 'uncollectible')
    : 'draft'

  const lineItems = (inv.lines?.data ?? []).map((line, i) => ({
    description: line.description ?? 'Line item',
    amountCents: line.amount,
    sortOrder: i
  }))

  // Derive period from line item date ranges
  let periodStart: string | null = null
  let periodEnd: string | null = null
  if (inv.lines?.data?.length) {
    const starts = inv.lines.data.map((l) => l.period?.start).filter((s): s is number => !!s)
    const ends = inv.lines.data.map((l) => l.period?.end).filter((e): e is number => !!e)
    if (starts.length > 0)
      periodStart = new Date(Math.min(...starts) * 1000).toISOString().split('T')[0]
    if (ends.length > 0) periodEnd = new Date(Math.max(...ends) * 1000).toISOString().split('T')[0]
  }

  return {
    clientId,
    stripeInvoiceId: inv.id,
    status,
    amountDueCents: inv.amount_due,
    amountPaidCents: inv.amount_paid,
    currency: inv.currency,
    memo: inv.description ?? null,
    hostedUrl: inv.hosted_invoice_url ?? null,
    invoicePdf: inv.invoice_pdf ?? null,
    dueDate: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
    paidAt: inv.status_transitions?.paid_at
      ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
      : null,
    periodStart,
    periodEnd,
    testMode: isTest,
    lineItems
  }
}

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
  ): Promise<GenerateLineItemsResult> {
    const client = clientProjectService.getClientById(clientId)
    if (!client) throw new AppError('CLIENT_NOT_FOUND', `Client ${clientId} not found`)
    if (!client.billableRate) {
      throw new AppError('NO_BILLABLE_RATE', 'Client has no billable rate configured')
    }

    const db = getDb()

    // Query sessions for this client — fetch all completed, then filter by local date
    const conditions = [
      eq(sessions.clientId, clientId),
      eq(sessions.status, 'completed'),
      eq(sessions.billable, 1)
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

    log.info(
      `Invoice generateLineItems: ${allRows.length} total sessions for client, ${sessionRows.length} in ${startDate} to ${endDate}`
    )
    if (sessionRows.length > 0) {
      const dates = [...new Set(sessionRows.map((s) => toDateKey(s.startedAt)))].sort()
      log.info(
        `Invoice date range found: ${dates[0]} to ${dates[dates.length - 1]} (${dates.length} days)`
      )
    }

    if (sessionRows.length === 0) return { lineItems: [], memo: null }

    // Load project names
    const projectRows = db.select().from(projects).all()
    const projectMap = new Map(projectRows.map((p) => [p.id, p.invoiceName ?? p.name]))

    // Group sessions by calendar day + project for separate line items
    const groupKey = (dateKey: string, projId: number | null) => `${dateKey}::${projId ?? 0}`
    const dayProjectGroups = new Map<
      string,
      {
        dateKey: string
        projectId: number | null
        projectName: string
        sessions: typeof sessionRows
        totalMinutes: number
      }
    >()

    for (const session of sessionRows) {
      const dateKey = toDateKey(session.startedAt)
      const key = groupKey(dateKey, session.projectId)
      if (!dayProjectGroups.has(key)) {
        const projectName = session.projectId
          ? (projectMap.get(session.projectId) ?? 'Unknown')
          : 'Unknown'
        dayProjectGroups.set(key, {
          dateKey,
          projectId: session.projectId,
          projectName,
          sessions: [],
          totalMinutes: 0
        })
      }
      const group = dayProjectGroups.get(key)!
      group.sessions.push(session)
      group.totalMinutes += session.durationMinutes
    }

    // ── Attribute commits to session days (same logic as reports) ──
    // For each unique projectId, get all commits and build commit-span attribution.
    // Result: commitsByDayProject maps "dateKey::projectId" → commit messages for that day.
    const commitsByDayProject = new Map<string, string[]>()
    const uniqueProjectIds = [
      ...new Set(
        Array.from(dayProjectGroups.values())
          .map((g) => g.projectId)
          .filter((id): id is number => id != null)
      )
    ]

    for (const projId of uniqueProjectIds) {
      // Get all commits for this project, sorted
      const allCommits = db
        .select()
        .from(gitCommits)
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
      const sessionDays = [
        ...new Set(
          Array.from(dayProjectGroups.values())
            .filter((g) => g.projectId === projId)
            .map((g) => g.dateKey)
        )
      ].sort()

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

    // Stripe caps line item descriptions at 500 characters (hard).
    const STRIPE_LINE_DESC_LIMIT = 500

    for (const group of sortedGroups) {
      // Skip days with negligible time (under 3 minutes = rounds to 0.0h)
      if (group.totalMinutes < 3) continue

      const hours = group.totalMinutes / 60
      const amountCents = Math.round(hours * client.billableRate! * 100)
      const sessionIds = group.sessions.map((s) => s.id)
      const dateFormatted = formatDateShort(group.dateKey)

      // Get the attributed commit messages for this day+project
      const dayCommitMsgs =
        commitsByDayProject.get(`${group.dateKey}::${group.projectId ?? 0}`) ?? []
      const ticketsForGroup = [
        ...new Set(
          dayCommitMsgs.map((m) => m.match(/\b[A-Z]{2,10}-\d{1,6}\b/)?.[0]).filter(Boolean)
        )
      ]

      const header = `${dateFormatted} ${group.projectName}:`
      // When N tickets > MAX_PER_TICKET_LINES (4), ai-service returns a single
      // combined summary + ticket list. Compute a generous cap for that mode;
      // otherwise compute a per-ticket budget so header + N decorated lines ≤ 500.
      const expectedLines = Math.max(1, ticketsForGroup.length || 1)
      const useCombined = expectedLines > 4
      let aiPerLineCap: number
      if (useCombined) {
        // Reserve space for header + " TICKET, TICKET, … — " + summary
        const ticketsStr = ticketsForGroup.join(', ')
        const reserved = header.length + 1 + ticketsStr.length + 3 // " — "
        aiPerLineCap = Math.max(80, STRIPE_LINE_DESC_LIMIT - reserved - 10)
      } else {
        const overheadPerLine = 15 // 2 spaces + "TICKET-NUM: " (~12) + 1 newline
        const reservedForLines = STRIPE_LINE_DESC_LIMIT - header.length - 1
        const dynamicPerLineCap = Math.max(
          40,
          Math.floor(reservedForLines / expectedLines) - overheadPerLine
        )
        aiPerLineCap = Math.min(80, dynamicPerLineCap)
      }

      // Try AI description
      let description = ''
      try {
        const result = await aiService.summarizeSessionGroup(
          sessionIds,
          group.projectName,
          dayCommitMsgs,
          aiPerLineCap
        )
        if (result && result.lines.length > 0) {
          if (result.combinedTickets && result.combinedTickets.length > 0) {
            // Many-tickets mode: render the ticket list inline, then the summary
            const ticketsStr = result.combinedTickets.join(', ')
            description = `${header} ${ticketsStr} — ${result.lines[0].description}`
          } else if (result.lines.length === 1) {
            const line = result.lines[0]
            const ticketPart = line.ticket ? `${line.ticket}: ` : ''
            description = `${header} ${ticketPart}${line.description}`
          } else {
            const ticketLines = result.lines.map((line) => {
              const ticketPart = line.ticket ? `${line.ticket}: ` : ''
              return `  ${ticketPart}${line.description}`
            })
            description = `${header}\n${ticketLines.join('\n')}`
          }
        }
      } catch (err) {
        log.warn(
          `AI description failed for ${group.dateKey}/${group.projectName}, using fallback:`,
          err
        )
      }

      // Verify final assembled length. If over, drop AI and use the deterministic fallback.
      if (description && description.length > STRIPE_LINE_DESC_LIMIT) {
        log.warn(
          `Assembled line description over Stripe cap (${description.length} > ${STRIPE_LINE_DESC_LIMIT}) for ${group.dateKey}/${group.projectName}; using deterministic fallback`
        )
        description = ''
      }

      // Fallback if AI unavailable or over cap (deterministic, always fits)
      if (!description) {
        const count = group.sessions.length
        description = `${header} Development work (${count} session${count > 1 ? 's' : ''}, ${hours.toFixed(1)}h)`
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

    // ── Generate overall memo summary ──
    const totalMinutes = lineItems.reduce((sum, li) => sum + li.durationMinutes, 0)
    const totalHours = (totalMinutes / 60).toFixed(1)
    const uniqueProjects = [...new Set(lineItems.flatMap((li) => li.projectNames))]
    const periodLabel = `${formatDateShort(startDate)} – ${formatDateShort(endDate)}`

    // Collect all tickets mentioned in descriptions
    // Match ticket-like tokens (e.g. PROJ-2643, WI-7), then drop common
    // non-ticket prefixes that share the same shape (UTF-8, ISO-8859, etc.).
    const ticketPattern = /\b[A-Z]{2,10}-\d{1,6}\b/g
    const NON_TICKET_PREFIXES = new Set([
      'UTF',
      'ASCII',
      'ISO',
      'COVID',
      'HTTP',
      'HTTPS',
      'IPV',
      'TLS',
      'SSL',
      'AES',
      'RSA',
      'SHA',
      'MD',
      'RFC',
      'OAUTH',
      'JWT',
      'API',
      'REST',
      'JSON',
      'XML',
      'YAML',
      'CSV',
      'HTML',
      'CSS',
      'JS',
      'TS',
      'EOL'
    ])
    const isLikelyTicket = (token: string): boolean => {
      const prefix = token.split('-')[0].toUpperCase()
      return !NON_TICKET_PREFIXES.has(prefix)
    }
    const allTickets = [
      ...new Set(
        lineItems.flatMap((li) =>
          (li.description.match(ticketPattern) ?? []).filter(isLikelyTicket)
        )
      )
    ]

    // Stripe's invoice description field has no documented public limit; treat
    // 500 as the safe budget (matches their 500-char cap on line item
    // descriptions and metadata values). The TOTAL HOURS footer is appended
    // after generation as a guaranteed line — AI must stay within
    // (500 − footer length). Period appears at the top of the memo body.
    const STRIPE_MEMO_LIMIT = 500
    const totalHoursFooter = `\n\nTOTAL HOURS: ${totalHours}`
    const memoBudget = STRIPE_MEMO_LIMIT - totalHoursFooter.length

    let memo: string | null = null
    const apiKey = credentialService.getApiKey()
    if (apiKey && lineItems.length > 1) {
      const summaryContext = lineItems.map((li) => li.description).join('\n')
      const buildPrompt = (charLimit: number): string =>
        [
          `Summarize the following invoice line items into a brief overall memo (2-3 sentences) for a client.`,
          `HARD LIMIT: your entire response MUST be ${charLimit} characters or fewer. This is non-negotiable — anything longer breaks the invoice.`,
          `This invoice covers ${periodLabel} for: ${uniqueProjects.join(', ')}.`,
          allTickets.length > 0 ? `Tickets worked: ${allTickets.join(', ')}.` : '',
          `CRITICAL: Only describe work that is explicitly mentioned in the line items below. Do NOT infer or invent work based on project names.`,
          `Use business-friendly language but stay accurate to what was actually done. Do NOT list individual days.`,
          `NEVER use "we" or "our" — this is a solo contractor. Omit the subject or use passive voice.`,
          `Output plain text only — no markdown, no bullets, no asterisks, no formatting.`,
          `Start the FIRST line with exactly: ${periodLabel}`,
          `Then on the next line(s), summarize what was accomplished. Do NOT mention total hours — that's appended separately.`,
          '',
          'Line items:',
          summaryContext
        ]
          .filter(Boolean)
          .join('\n')

      const callAi = async (charLimit: number): Promise<string | null> => {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            messages: [{ role: 'user', content: buildPrompt(charLimit) }]
          })
        })
        if (!response.ok) return null
        const data = await response.json()
        return data.content?.[0]?.type === 'text' ? (data.content[0].text?.trim() ?? null) : null
      }

      try {
        let aiMemo = await callAi(memoBudget)
        if (aiMemo && aiMemo.length > memoBudget) {
          log.warn(
            `AI memo over budget (${aiMemo.length} > ${memoBudget}), regenerating with tighter cap`
          )
          aiMemo = await callAi(Math.max(200, memoBudget - 80))
        }
        if (aiMemo && aiMemo.length <= memoBudget) {
          memo = aiMemo
        } else if (aiMemo) {
          log.warn(
            `AI memo still over budget after retry (${aiMemo.length} > ${memoBudget}); using fallback`
          )
        }
      } catch (err) {
        log.warn('AI invoice memo generation failed:', err)
      }
    }

    // Deterministic fallback — period at top, drop tickets that don't fit
    if (!memo) {
      const head = `${periodLabel} · ${uniqueProjects.join(', ')}`
      let body = head
      if (allTickets.length > 0) {
        const prefix = '\nTickets: '
        const remaining = memoBudget - head.length - prefix.length
        const fitTickets: string[] = []
        let used = 0
        for (const t of allTickets) {
          const add = (fitTickets.length > 0 ? 2 : 0) + t.length
          if (used + add > remaining) break
          fitTickets.push(t)
          used += add
        }
        if (fitTickets.length > 0) body += `${prefix}${fitTickets.join(', ')}`
      }
      memo = body
    }

    // TOTAL HOURS is always appended last and never dropped
    memo = `${memo}${totalHoursFooter}`

    return { lineItems, memo }
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
    invoicePdf?: string | null
    dueDate?: string | null
    paidAt?: string | null
    periodStart?: string | null
    periodEnd?: string | null
    testMode?: boolean
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

    let invoiceId = 0
    db.transaction((tx) => {
      const invoice = tx
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
          invoicePdf: data.invoicePdf ?? null,
          dueDate: data.dueDate ?? null,
          paidAt: data.paidAt ?? null,
          periodStart: data.periodStart ?? null,
          periodEnd: data.periodEnd ?? null,
          testMode: data.testMode ? 1 : 0,
          createdAt: now,
          updatedAt: now
        })
        .returning()
        .get()

      invoiceId = invoice.id

      for (const item of data.lineItems) {
        tx.insert(invoiceLineItems)
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
    })

    log.info(`Saved invoice locally: id=${invoiceId}, stripe=${data.stripeInvoiceId}`)
    return invoiceId
  },

  /**
   * Get all local invoices, optionally filtered.
   */
  getAll(filters?: { clientId?: number; status?: string; testMode?: boolean }): LocalInvoice[] {
    const db = getDb()
    const conditions: ReturnType<typeof eq>[] = []

    if (filters?.clientId != null) {
      conditions.push(eq(invoices.clientId, filters.clientId))
    }
    if (filters?.status) {
      conditions.push(
        eq(invoices.status, filters.status as 'draft' | 'open' | 'paid' | 'void' | 'uncollectible')
      )
    }
    if (filters?.testMode != null) {
      conditions.push(eq(invoices.testMode, filters.testMode ? 1 : 0))
    }

    const rows =
      conditions.length > 0
        ? db
            .select()
            .from(invoices)
            .where(and(...conditions))
            .orderBy(desc(invoices.createdAt))
            .all()
        : db.select().from(invoices).orderBy(desc(invoices.createdAt)).all()

    // Join client names (masked to stage names while presentation mode is on)
    const presentationMode = settingsService.getSetting('presentation_mode') === 'true'
    const clientRows = db.select().from(clients).all()
    const clientMap = new Map(
      clientRows.map((c) => [c.id, presentationMode ? c.stageName || clientAlias(c.id) : c.name])
    )

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
      invoicePdf: row.invoicePdf,
      dueDate: row.dueDate,
      paidAt: row.paidAt,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      testMode: !!row.testMode,
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
    const presentationMode = settingsService.getSetting('presentation_mode') === 'true'
    const clientDisplayName = clientRow
      ? presentationMode
        ? clientRow.stageName || clientAlias(clientRow.id)
        : clientRow.name
      : 'Unknown'
    const items = db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, localId))
      .orderBy(invoiceLineItems.sortOrder)
      .all()

    return {
      id: row.id,
      clientId: row.clientId,
      clientName: clientDisplayName,
      stripeInvoiceId: row.stripeInvoiceId,
      status: row.status as LocalInvoice['status'],
      amountDueCents: row.amountDueCents,
      amountPaidCents: row.amountPaidCents,
      currency: row.currency,
      memo: row.memo,
      hostedUrl: row.hostedUrl,
      invoicePdf: row.invoicePdf,
      dueDate: row.dueDate,
      paidAt: row.paidAt,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      testMode: !!row.testMode,
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
        invoicePdf: stripeStatus.invoicePdf,
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
              invoicePdf: stripeStatus.invoicePdf,
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
   * Delete a local invoice and its line items. Does NOT affect Stripe.
   */
  deleteInvoice(localId: number): void {
    const db = getDb()
    const row = db.select().from(invoices).where(eq(invoices.id, localId)).get()
    if (!row) throw new AppError('INVOICE_NOT_FOUND', `Invoice ${localId} not found`)

    db.transaction((tx) => {
      tx.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, localId)).run()
      tx.delete(invoices).where(eq(invoices.id, localId)).run()
    })
    log.info(`Deleted local invoice id=${localId}, stripe=${row.stripeInvoiceId}`)
  },

  /**
   * Import invoices from Stripe that aren't already in the local DB.
   * Matches clients by stripeCustomerId. Returns count imported.
   */
  async importFromStripe(): Promise<number> {
    const db = getDb()

    const existingIds = new Set(
      db
        .select({ sid: invoices.stripeInvoiceId })
        .from(invoices)
        .all()
        .map((r) => r.sid)
    )

    // Build client lookup by stripeCustomerId
    const clientRows = db.select().from(clients).all()
    const clientByStripeId = new Map<string, number>()
    for (const c of clientRows) {
      if (c.stripeCustomerId) clientByStripeId.set(c.stripeCustomerId, c.id)
    }

    const stripeInvoices = await stripeService.listInvoices()
    const isTest = credentialService.isStripeTestMode()
    let imported = 0

    for (const inv of stripeInvoices) {
      if (existingIds.has(inv.id)) continue

      const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id
      const clientId = customerId ? clientByStripeId.get(customerId) : undefined
      if (!clientId) {
        log.info(
          `Skipping Stripe invoice ${inv.id} — no matching local client for customer ${customerId}`
        )
        continue
      }

      this.saveInvoice(mapStripeInvoiceToLocal(inv, clientId, isTest))
      imported++
      log.info(`Imported Stripe invoice ${inv.id} for client ${clientId}`)
    }

    log.info(`Imported ${imported} invoices from Stripe`)
    return imported
  },

  /**
   * Check for overlapping invoices for a client in a date range.
   */
  checkOverlap(clientId: number, startDate: string, endDate: string): InvoiceOverlap[] {
    const db = getDb()
    const isTest = credentialService.isStripeTestMode()
    const rows = db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.clientId, clientId),
          eq(invoices.testMode, isTest ? 1 : 0),
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
