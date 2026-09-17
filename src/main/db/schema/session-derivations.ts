import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions'

/** Local detector baseline. User-edited times live on the session, not here. */
export const sessionDerivations = sqliteTable('session_derivations', {
  sessionId: integer('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at').notNull(),
  durationMinutes: integer('duration_minutes').notNull()
})

/** Explicit local time edits remain overrides even when measurements catch up. */
export const sessionTimeOverrides = sqliteTable('session_time_overrides', {
  sessionId: integer('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  startedAt: integer('started_at').notNull().default(0),
  endedAt: integer('ended_at').notNull().default(0),
  durationMinutes: integer('duration_minutes').notNull().default(0)
})
