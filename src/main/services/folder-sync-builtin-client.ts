import { createHash } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { clients, type ClientRow } from '../db/schema/clients'
import { projects, type ProjectRow } from '../db/schema/projects'
import type { SyncDomainAdapter } from './folder-sync-store'
import { linkedLocalId, linkedPortableId } from './folder-sync-identity-links'

/*
 * The built-in Unassigned client's portable identity.
 *
 * Every install creates its own Unassigned row with a random local syncId, marked by
 * clients.system_role. That row is exported under one reserved UUID shared by every computer in a
 * workspace, so auto-captured projects converge on the same client. The role, never the name,
 * defines the identity: renaming the built-in keeps its role, and an ordinary client that happens
 * to be called "Unassigned" stays a separate record. Local IDs and syncIds are never rewritten.
 */

type Reader = Pick<Parameters<SyncDomainAdapter['apply']>[0], 'select'>

export const UNASSIGNED_CLIENT_ROLE = 'unassigned'
export const UNASSIGNED_CLIENT_NAME = 'Unassigned'
export const UNASSIGNED_CLIENT_COLOR = '#6b7280'

function purposeUuid(purpose: string): string {
  const hex = createHash('sha256').update(purpose).digest('hex')
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Version 8 UUID naming the built-in Unassigned client in every workspace. Never change it. */
export const UNASSIGNED_CLIENT_SYNC_ID = purposeUuid('clautime-builtin-client-unassigned-1')

type ClientIdentity = Pick<ClientRow, 'syncId' | 'systemRole'>

/**
 * The ID a client row is exported under, ignoring join links: the reserved UUID for the
 * built-in, else its syncId. Prefer portableIdOfClientRow/getPortableClientId, which also
 * apply an explicit join link (folder-sync-identity-links.ts).
 */
export function portableClientId(row: ClientIdentity): string {
  return row.systemRole === UNASSIGNED_CLIENT_ROLE ? UNASSIGNED_CLIENT_SYNC_ID : row.syncId
}

/** Portable ID of a client row: the built-in's reserved UUID, a join link, else its syncId. */
export function portableIdOfClientRow(
  db: Reader,
  row: ClientIdentity & Pick<ClientRow, 'id'>
): string {
  if (row.systemRole === UNASSIGNED_CLIENT_ROLE) return UNASSIGNED_CLIENT_SYNC_ID
  return linkedPortableId(db, 'client', row.id) ?? row.syncId
}

/** Portable ID of a local client, or null when no such client exists. */
export function getPortableClientId(db: Reader, clientId: number): string | null {
  const row = db
    .select({ id: clients.id, syncId: clients.syncId, systemRole: clients.systemRole })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get()
  return row ? portableIdOfClientRow(db, row) : null
}

/**
 * The local row a portable client ID names. The reserved UUID resolves by role, whatever the
 * row's local syncId; the built-in's own local syncId is not a portable identity. A shared ID
 * explicitly linked during join review resolves to the linked local row. A linked row's own
 * syncId still resolves to it locally; it was never exported, so no shared record names it.
 */
export function findClientByPortableId(db: Reader, portableId: string): ClientRow | null {
  if (portableId === UNASSIGNED_CLIENT_SYNC_ID)
    return (
      db.select().from(clients).where(eq(clients.systemRole, UNASSIGNED_CLIENT_ROLE)).get() ?? null
    )
  const linked = linkedLocalId(db, 'client', portableId)
  if (linked !== null)
    return (
      db
        .select()
        .from(clients)
        .where(and(eq(clients.id, linked), isNull(clients.systemRole)))
        .get() ?? null
    )
  return (
    db
      .select()
      .from(clients)
      .where(and(eq(clients.syncId, portableId), isNull(clients.systemRole)))
      .get() ?? null
  )
}

/** Normalizes a local client syncId (or an already portable ID) to its portable ID. */
export function portableIdOfLocalClient(db: Reader, syncId: string): string {
  const row = db
    .select({ id: clients.id, syncId: clients.syncId, systemRole: clients.systemRole })
    .from(clients)
    .where(eq(clients.syncId, syncId))
    .get()
  return row ? portableIdOfClientRow(db, row) : syncId
}

// ── Projects use the same translation; only a join link differs from the row's syncId ──

/** Portable ID of a project row: a join link, else its syncId. */
export function portableIdOfProjectRow(db: Reader, row: Pick<ProjectRow, 'id' | 'syncId'>): string {
  return linkedPortableId(db, 'project', row.id) ?? row.syncId
}

/** Portable ID of a local project, or null when no such project exists. */
export function getPortableProjectId(db: Reader, projectId: number): string | null {
  const row = db
    .select({ id: projects.id, syncId: projects.syncId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get()
  return row ? portableIdOfProjectRow(db, row) : null
}

/** The local row a portable project ID names, following an explicit join link first. */
export function findProjectByPortableId(db: Reader, portableId: string): ProjectRow | null {
  const linked = linkedLocalId(db, 'project', portableId)
  if (linked !== null)
    return db.select().from(projects).where(eq(projects.id, linked)).get() ?? null
  return db.select().from(projects).where(eq(projects.syncId, portableId)).get() ?? null
}

/** Normalizes a local project syncId (or an already portable ID) to its portable ID. */
export function portableIdOfLocalProject(db: Reader, syncId: string): string {
  const row = db
    .select({ id: projects.id, syncId: projects.syncId })
    .from(projects)
    .where(eq(projects.syncId, syncId))
    .get()
  return row ? portableIdOfProjectRow(db, row) : syncId
}
