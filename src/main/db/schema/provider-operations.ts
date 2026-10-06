import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Frozen requests precede provider writes; credentials never belong in these records. */
export const providerOperations = sqliteTable('provider_operations', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  testMode: integer('test_mode').notNull(),
  kind: text('kind').notNull(),
  requestJson: text('request_json').notNull()
})

export const providerOperationSteps = sqliteTable(
  'provider_operation_steps',
  {
    operationId: text('operation_id')
      .notNull()
      .references(() => providerOperations.id),
    name: text('name').notNull(),
    requestJson: text('request_json').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    /** Stripe response Date, not this computer's clock. */
    startedProviderAt: text('started_provider_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.operationId, table.name] })]
)

export const providerOperationResults = sqliteTable(
  'provider_operation_results',
  {
    operationId: text('operation_id')
      .notNull()
      .references(() => providerOperations.id),
    name: text('name').notNull(),
    resultJson: text('result_json').notNull()
  },
  (table) => [primaryKey({ columns: [table.operationId, table.name] })]
)

/**
 * Stripe's definite rejection of a started step (validation before any effect). Terminal: the
 * frozen request cannot change, so the step is never attempted again. Never with a result.
 */
export const providerOperationRejections = sqliteTable(
  'provider_operation_rejections',
  {
    operationId: text('operation_id').notNull(),
    name: text('name').notNull(),
    proofJson: text('proof_json').notNull()
  },
  (table) => [primaryKey({ columns: [table.operationId, table.name] })]
)

/** An explicit user resolution, recorded only with proof that the operation left no effect. */
export const providerOperationResolutions = sqliteTable('provider_operation_resolutions', {
  operationId: text('operation_id')
    .primaryKey()
    .references(() => providerOperations.id),
  resolution: text('resolution').notNull().$type<'cancelled'>(),
  proofJson: text('proof_json').notNull()
})
