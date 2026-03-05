import { eq, isNull } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { AppError } from '../../shared/types/ipc'
import { CLIENT_COLORS } from '../../shared/types/client-project'
import { normalizePath } from '../../shared/paths'
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
    color: row.color,
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
      .values({ name: data.name, color, createdAt: now, updatedAt: now })
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
        ...(data.color !== undefined && { color: data.color }),
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

    const result = db
      .insert(projects)
      .values({
        clientId: data.clientId,
        name: data.name,
        directoryPath: normalizePath(data.directoryPath),
        isBillable: data.isBillable ?? true,
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
        ...(data.isBillable !== undefined && { isBillable: data.isBillable }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(data.clientId !== undefined && { clientId: data.clientId }),
        updatedAt: now
      })
      .where(eq(projects.id, id))
      .returning()
      .get()

    log.info(`Updated project: ${result.name} (id=${id})`)
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
    const unattributed = db
      .select()
      .from(sessions)
      .where(isNull(sessions.projectId))
      .all()

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
