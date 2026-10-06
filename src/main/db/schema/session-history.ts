import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
  primaryKey,
  type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions'
import { sessionLegacyRecords } from './session-legacy'
import type { InvoiceBillingRange } from '../../../shared/types/invoice'

export const sessionRevisions = sqliteTable(
  'session_revisions',
  {
    id: text('id').primaryKey(),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id),
    sequence: integer('sequence').notNull(),
    parentRevisionId: text('parent_revision_id').references(
      (): AnySQLiteColumn => sessionRevisions.id
    ),
    kind: text('kind').notNull().$type<'edit' | 'split' | 'reconcile' | 'policy'>(),
    sourceFile: text('source_file'),
    tool: text('tool').notNull(),
    claudeSessionId: text('claude_session_id'),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    before: text('before_json').notNull(),
    after: text('after_json').notNull(),
    createdAt: text('created_at').notNull()
  },
  (table) => [uniqueIndex('idx_session_revisions_sequence').on(table.sessionId, table.sequence)]
)

/** An immutable split revision and its local predecessor/child mapping. */
export const sessionSplits = sqliteTable('session_splits', {
  revisionId: text('revision_id')
    .primaryKey()
    .references(() => sessionRevisions.id),
  parentSessionId: integer('parent_session_id')
    .notNull()
    .unique()
    .references(() => sessions.id),
  firstSessionId: integer('first_session_id')
    .notNull()
    .unique()
    .references(() => sessions.id),
  secondSessionId: integer('second_session_id')
    .notNull()
    .unique()
    .references(() => sessions.id),
  sourceFile: text('source_file'),
  tool: text('tool').notNull(),
  claudeSessionId: text('claude_session_id'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at').notNull(),
  splitAt: text('split_at').notNull(),
  // Saved times describe a legacy snapshot, not measured activity anchors.
  legacyRecordId: text('legacy_record_id').references(() => sessionLegacyRecords.id)
})

/** Approved recalculation links; predecessors remain non-counting audit rows. */
export const sessionReplacements = sqliteTable(
  'session_replacements',
  {
    predecessorSessionId: integer('predecessor_session_id')
      .notNull()
      .references(() => sessions.id),
    successorSessionId: integer('successor_session_id')
      .notNull()
      .references(() => sessions.id),
    revisionId: text('revision_id')
      .notNull()
      .references(() => sessionRevisions.id)
  },
  (table) => [
    primaryKey({ columns: [table.predecessorSessionId, table.successorSessionId] }),
    index('idx_session_replacements_successor').on(table.successorSessionId)
  ]
)

/** Local billed-work audit survives hiding an invoice; portable links follow in FS06. */
export const sessionBillingRefs = sqliteTable(
  'session_billing_refs',
  {
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id),
    stripeInvoiceId: text('stripe_invoice_id').notNull(),
    testMode: integer('test_mode').notNull(),
    billedRanges: text('billed_ranges', { mode: 'json' }).$type<InvoiceBillingRange[]>()
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.stripeInvoiceId, table.testMode] })]
)
