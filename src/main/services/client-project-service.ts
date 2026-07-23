import { eq, isNull } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { AppError } from '../../shared/types/ipc'
import { CLIENT_COLORS } from '../../shared/types/client-project'
import { normalizePath, getProjectName, isExcludedProjectPath } from '../../shared/paths'
import type {
  Client,
  NewClient,
  UpdateClient,
  Project,
  NewProject,
  UpdateProject
} from '../../shared/types/client-project'

/** Map a DB row (integer booleans) to a Client interface (real booleans). */
function toClient(row: typeof clients.$inferSelect): Client {
  return {
    id: row.id,
    name: row.name,
    stageName: row.stageName ?? null,
    color: row.color,
    billableRate: row.billableRate ?? null,
    email: row.email ?? null,
    stripeCustomerId: row.stripeCustomerId ?? null,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

/** Map a DB row to a Project interface. */
function toProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    invoiceName: row.invoiceName ?? null,
    stageName: row.stageName ?? null,
    hourlyRate: row.hourlyRate ?? null,
    directoryPath: row.directoryPath,
    isBillable: row.isBillable,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export const clientProjectService = {
  // ── Client CRUD ──

  getClients(): Client[] {
    const db = getDb()
    return db.select().from(clients).orderBy(clients.name).all().map(toClient)
  },

  getClientById(id: number): Client | null {
    const db = getDb()
    const row = db.select().from(clients).where(eq(clients.id, id)).get()
    return row ? toClient(row) : null
  },

  createClient(data: NewClient): Client {
    const db = getDb()
    const now = new Date().toISOString()

    // Auto-assign color if not provided: pick the next color not yet used
    let color = data.color
    if (!color) {
      const usedColors = new Set(
        db
          .select({ color: clients.color })
          .from(clients)
          .all()
          .map((r) => r.color)
      )
      color = CLIENT_COLORS.find((c) => !usedColors.has(c)) ?? CLIENT_COLORS[0]
    }

    const result = db
      .insert(clients)
      .values({
        name: data.name,
        stageName: data.stageName ?? null,
        color,
        billableRate: data.billableRate ?? null,
        email: data.email ?? null,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .get()

    log.info(`Created client: ${result.name} (id=${result.id})`)
    return toClient(result)
  },

  updateClient(id: number, data: UpdateClient): Client {
    const db = getDb()
    const existing = db.select().from(clients).where(eq(clients.id, id)).get()
    if (!existing) {
      throw new AppError('CLIENT_NOT_FOUND', `Client with id ${id} not found`)
    }

    const now = new Date().toISOString()
    const result = db
      .update(clients)
      .set({
        ...(data.name !== undefined && { name: data.name }),
        ...(data.stageName !== undefined && { stageName: data.stageName }),
        ...(data.color !== undefined && { color: data.color }),
        ...(data.billableRate !== undefined && { billableRate: data.billableRate }),
        ...(data.email !== undefined && { email: data.email }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        updatedAt: now
      })
      .where(eq(clients.id, id))
      .returning()
      .get()

    log.info(`Updated client: ${result.name} (id=${id})`)
    return toClient(result)
  },

  deleteClient(id: number): void {
    const db = getDb()
    const existing = db.select().from(clients).where(eq(clients.id, id)).get()
    if (!existing) {
      throw new AppError('CLIENT_NOT_FOUND', `Client with id ${id} not found`)
    }

    db.transaction((tx) => {
      // Nullify session references for all sessions linked to this client
      // (covers both direct clientId refs and projectId refs via client's projects)
      tx.update(sessions)
        .set({ projectId: null, clientId: null, updatedAt: new Date().toISOString() })
        .where(eq(sessions.clientId, id))
        .run()

      tx.delete(projects).where(eq(projects.clientId, id)).run()
      tx.delete(clients).where(eq(clients.id, id)).run()
    })

    log.info(`Deleted client id=${id} and its projects`)
  },

  // ── Project CRUD ──

  getProjects(clientId?: number): Project[] {
    const db = getDb()
    if (clientId !== undefined) {
      return db
        .select()
        .from(projects)
        .where(eq(projects.clientId, clientId))
        .orderBy(projects.name)
        .all()
        .map(toProject)
    }
    return db.select().from(projects).orderBy(projects.name).all().map(toProject)
  },

  getProjectById(id: number): Project | null {
    const db = getDb()
    const row = db.select().from(projects).where(eq(projects.id, id)).get()
    return row ? toProject(row) : null
  },

  createProject(data: NewProject): Project {
    const db = getDb()
    const now = new Date().toISOString()

    // Verify client exists
    const client = db.select().from(clients).where(eq(clients.id, data.clientId)).get()
    if (!client) {
      throw new AppError('CLIENT_NOT_FOUND', `Client with id ${data.clientId} not found`)
    }

    const normalized = normalizePath(data.directoryPath)

    // Check if a project with this directory already exists (e.g. under Unassigned)
    // If so, move it to the new client instead of duplicating
    const existing = this.findProjectByDirectory(normalized)
    if (existing) {
      if (existing.clientId === data.clientId) {
        return existing // already under this client
      }
      const result = db
        .update(projects)
        .set({
          clientId: data.clientId,
          name: data.name,
          isBillable: data.isBillable ?? existing.isBillable,
          updatedAt: now
        })
        .where(eq(projects.id, existing.id))
        .returning()
        .get()

      // Update sessions to reflect new client
      db.update(sessions)
        .set({ clientId: data.clientId, updatedAt: now })
        .where(eq(sessions.projectId, existing.id))
        .run()

      log.info(
        `Moved project: ${result.name} (id=${existing.id}) from client ${existing.clientId} to ${data.clientId}`
      )
      return toProject(result)
    }

    const result = db
      .insert(projects)
      .values({
        clientId: data.clientId,
        name: data.name,
        directoryPath: normalized,
        isBillable: data.isBillable ?? true,
        stageName: data.stageName ?? null,
        hourlyRate: data.hourlyRate ?? null,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .get()

    log.info(`Created project: ${result.name} (id=${result.id}, client=${data.clientId})`)
    return toProject(result)
  },

  updateProject(id: number, data: UpdateProject): Project {
    const db = getDb()
    const existing = db.select().from(projects).where(eq(projects.id, id)).get()
    if (!existing) {
      throw new AppError('PROJECT_NOT_FOUND', `Project with id ${id} not found`)
    }

    if (data.clientId !== undefined) {
      const client = db.select().from(clients).where(eq(clients.id, data.clientId)).get()
      if (!client) {
        throw new AppError('CLIENT_NOT_FOUND', `Client with id ${data.clientId} not found`)
      }
    }

    const now = new Date().toISOString()
    const result = db
      .update(projects)
      .set({
        ...(data.name !== undefined && { name: data.name }),
        ...(data.directoryPath !== undefined && {
          directoryPath: normalizePath(data.directoryPath)
        }),
        ...(data.invoiceName !== undefined && { invoiceName: data.invoiceName }),
        ...(data.stageName !== undefined && { stageName: data.stageName }),
        ...(data.hourlyRate !== undefined && { hourlyRate: data.hourlyRate }),
        ...(data.isBillable !== undefined && { isBillable: data.isBillable }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(data.clientId !== undefined && { clientId: data.clientId }),
        updatedAt: now
      })
      .where(eq(projects.id, id))
      .returning()
      .get()

    // If client changed, update all sessions for this project too
    if (data.clientId !== undefined && data.clientId !== existing.clientId) {
      db.update(sessions)
        .set({ clientId: data.clientId, updatedAt: now })
        .where(eq(sessions.projectId, id))
        .run()
      log.info(
        `Moved project: ${result.name} (id=${id}) from client ${existing.clientId} to ${data.clientId}`
      )
    } else {
      log.info(`Updated project: ${result.name} (id=${id})`)
    }

    return toProject(result)
  },

  deleteProject(id: number): void {
    const db = getDb()
    const existing = db.select().from(projects).where(eq(projects.id, id)).get()
    if (!existing) {
      throw new AppError('PROJECT_NOT_FOUND', `Project with id ${id} not found`)
    }

    db.transaction((tx) => {
      tx.update(sessions)
        .set({ projectId: null, clientId: null, updatedAt: new Date().toISOString() })
        .where(eq(sessions.projectId, id))
        .run()

      tx.delete(projects).where(eq(projects.id, id)).run()
    })

    log.info(`Deleted project id=${id}`)
  },

  // ── Auto-Detection ──

  getOrCreateUnassignedClient(): Client {
    const db = getDb()
    const existing = db.select().from(clients).where(eq(clients.name, 'Unassigned')).get()
    if (existing) return toClient(existing)

    const now = new Date().toISOString()
    try {
      const result = db
        .insert(clients)
        .values({
          name: 'Unassigned',
          color: '#6b7280',
          createdAt: now,
          updatedAt: now
        })
        .returning()
        .get()

      log.info(`Created "Unassigned" client (id=${result.id})`)
      return toClient(result)
    } catch (err: unknown) {
      // UNIQUE constraint race — re-query
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        const row = db.select().from(clients).where(eq(clients.name, 'Unassigned')).get()
        if (row) return toClient(row)
      }
      throw err
    }
  },

  autoCreateProject(directoryPath: string): Project | null {
    // Never auto-create projects for piped-swarm worktrees (…/pipes/…)
    if (isExcludedProjectPath(directoryPath)) return null
    const existing = this.findProjectByDirectory(directoryPath)
    if (existing) return null

    const unassigned = this.getOrCreateUnassignedClient()
    const name = getProjectName(directoryPath)
    const normalized = normalizePath(directoryPath)
    const now = new Date().toISOString()

    try {
      const db = getDb()
      const result = db
        .insert(projects)
        .values({
          clientId: unassigned.id,
          name,
          directoryPath: normalized,
          isBillable: false,
          createdAt: now,
          updatedAt: now
        })
        .returning()
        .get()

      log.info(`Auto-created project: ${name} (id=${result.id}) under Unassigned`)
      return toProject(result)
    } catch (err: unknown) {
      // UNIQUE constraint race condition — project was created between check and insert
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        log.debug(`autoCreateProject: UNIQUE conflict for ${normalized}, already exists`)
        return null
      }
      throw err
    }
  },

  /**
   * Delete lingering projects whose directory is now excluded (rows
   * auto-created before an exclusion rule existed). The exclusion is a path
   * heuristic, so anything showing signs of deliberate user setup is spared:
   * projects with user-set fields (invoice/stage name, hourly rate, billable),
   * a client other than Unassigned, or ANY sessions still attached — the
   * session purge runs first, so whatever remains was spared on purpose and
   * must not lose its attribution via deleteProject.
   * Returns count deleted.
   */
  purgeExcludedProjects(): number {
    const db = getDb()
    const stale = db
      .select()
      .from(projects)
      .all()
      .filter((p) => isExcludedProjectPath(p.directoryPath))
    if (stale.length === 0) return 0

    const unassigned = this.getOrCreateUnassignedClient()
    let deleted = 0
    for (const p of stale) {
      const userConfigured =
        p.invoiceName !== null ||
        p.stageName !== null ||
        p.hourlyRate !== null ||
        p.isBillable ||
        p.clientId !== unassigned.id
      const hasSessions =
        db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.projectId, p.id))
          .limit(1)
          .get() !== undefined
      if (userConfigured || hasSessions) {
        log.warn(
          `Skipping purge of excluded-path project "${p.name}" (${p.directoryPath}): ` +
            `${userConfigured ? 'user-configured' : 'has surviving sessions'}`
        )
        continue
      }
      this.deleteProject(p.id)
      log.info(`Purged excluded-path project "${p.name}" (${p.directoryPath})`)
      deleted++
    }
    return deleted
  },

  /**
   * Return IDs of all excluded (inactive) projects for query filtering.
   */
  getExcludedProjectIds(): number[] {
    const db = getDb()
    return db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.isActive, false))
      .all()
      .map((r) => r.id)
  },

  /**
   * Return directory paths of all excluded (inactive) projects.
   */
  getExcludedProjectPaths(): string[] {
    const db = getDb()
    return db
      .select({ directoryPath: projects.directoryPath })
      .from(projects)
      .where(eq(projects.isActive, false))
      .all()
      .map((r) => r.directoryPath.toLowerCase())
  },

  // ── Directory Mapping ──

  findProjectByDirectory(directoryPath: string): Project | null {
    const db = getDb()
    const normalized = normalizePath(directoryPath)

    // Exact match (case-insensitive on Windows via LOWER)
    const allProjects = db.select().from(projects).all()
    const match = allProjects.find(
      (p) => normalizePath(p.directoryPath).toLowerCase() === normalized.toLowerCase()
    )
    return match ? toProject(match) : null
  },

  /**
   * Scan all sessions with null projectId, attempt to match by projectPath → directory_path.
   * Returns count of newly attributed sessions.
   */
  attributeSessions(): number {
    const db = getDb()
    const unattributed = db.select().from(sessions).where(isNull(sessions.projectId)).all()

    if (unattributed.length === 0) return 0

    const allProjects = db.select().from(projects).all()
    if (allProjects.length === 0) return 0

    let count = 0
    const now = new Date().toISOString()

    db.transaction((tx) => {
      for (const session of unattributed) {
        const normalized = normalizePath(session.projectPath).toLowerCase()
        const match = allProjects.find(
          (p) => normalizePath(p.directoryPath).toLowerCase() === normalized
        )
        if (match) {
          tx.update(sessions)
            .set({
              projectId: match.id,
              clientId: match.clientId,
              updatedAt: now
            })
            .where(eq(sessions.id, session.id))
            .run()
          count++
        }
      }
    })

    log.info(`Attributed ${count} sessions to projects`)
    return count
  }
}
