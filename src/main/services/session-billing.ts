import { eq } from 'drizzle-orm'
import type { getDb } from '../db'
import { sessions } from '../db/schema/sessions'
import type { Session } from '../db/schema/sessions'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import {
  sessionBillingRefs,
  sessionSplits,
  sessionReplacements
} from '../db/schema/session-history'
import type { InvoiceBillingRange } from '../../shared/types/invoice'

type BillingDb = Pick<ReturnType<typeof getDb>, 'select' | 'insert'>

function invoiceRefs(db: Pick<BillingDb, 'select'>) {
  return db
    .select({
      sessionIds: invoiceLineItems.sessionIds,
      stripeInvoiceId: invoices.stripeInvoiceId,
      testMode: invoices.testMode
    })
    .from(invoiceLineItems)
    .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
    .all()
    .flatMap((row) =>
      (row.sessionIds ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0)
        .map((id) => ({
          sessionId: Number(id),
          stripeInvoiceId: row.stripeInvoiceId,
          testMode: row.testMode
        }))
    )
}

export function billingRange(session: Session): InvoiceBillingRange {
  return {
    sessionId: session.id,
    projectId: session.projectId,
    clientId: session.clientId,
    startedAt: session.startedAt,
    endedAt: session.endedAt
  }
}

/** Freeze new references once; hiding invoices or splitting cannot widen them. */
export function retainInvoiceBillingRefs(
  tx: BillingDb,
  captured?: { stripeInvoiceId: string; ranges: Map<number, InvoiceBillingRange[]> }
): void {
  const rows = new Map(
    tx
      .select()
      .from(sessions)
      .all()
      .map((row) => [row.id, row])
  )
  for (const ref of invoiceRefs(tx)) {
    const row = rows.get(ref.sessionId)
    if (!row) continue
    const frozen =
      ref.stripeInvoiceId === captured?.stripeInvoiceId
        ? captured.ranges.get(ref.sessionId)
        : undefined
    tx.insert(sessionBillingRefs)
      .values({ ...ref, billedRanges: frozen ?? [billingRange(row)] })
      .onConflictDoNothing()
      .run()
  }
}

/** Subtract billed wall-clock intervals within the original bucket or shared history lineage. */
export function unbilledSessions(db: BillingDb, rows: Session[], testMode: boolean): Session[] {
  retainInvoiceBillingRefs(db)
  const ranges = db
    .select()
    .from(sessionBillingRefs)
    .where(eq(sessionBillingRefs.testMode, Number(testMode)))
    .all()
    .flatMap((ref) => ref.billedRanges ?? [])
  const parents = new Map(
    db
      .select()
      .from(sessionSplits)
      .all()
      .flatMap((s) => [
        [s.firstSessionId, s.parentSessionId] as const,
        [s.secondSessionId, s.parentSessionId] as const
      ])
  )
  const root = (id: number): number => {
    while (parents.has(id)) id = parents.get(id)!
    return id
  }
  // Merges can have several predecessors; connect their billing lineages.
  for (const edge of db.select().from(sessionReplacements).all()) {
    const predecessor = root(edge.predecessorSessionId)
    const successor = root(edge.successorSessionId)
    if (predecessor !== successor) parents.set(successor, predecessor)
  }
  return rows.flatMap((row) => {
    let remaining = [[Date.parse(row.startedAt), Date.parse(row.endedAt)]]
    for (const range of ranges) {
      const sameBucket = range.clientId === row.clientId && range.projectId === row.projectId
      if (!sameBucket && root(range.sessionId) !== root(row.id)) continue
      const start = Date.parse(range.startedAt)
      const end = Date.parse(range.endedAt)
      remaining = remaining.flatMap(([a, b]) => {
        if (end <= a || start >= b) return [[a, b]]
        return [...(a < start ? [[a, start]] : []), ...(end < b ? [[end, b]] : [])]
      })
      if (!remaining.length) break
    }
    return remaining
      .filter(([a, b]) => b > a)
      .map(([a, b]) => ({
        ...row,
        startedAt: new Date(a).toISOString(),
        endedAt: new Date(b).toISOString(),
        durationMinutes: (b - a) / 60_000
      }))
  })
}
