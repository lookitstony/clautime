import { journalSessionMutations } from './folder-sync-session-local'
import { eq, and } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { activeSessionCondition } from '../db/schema/session-deletions'
import { mainProjectPath } from './worktree-paths'
import { getLocalDeviceSession } from './device-context'
import { isLocalProjectSetupComplete } from './local-project-setup'
import {
  emitMarkedFolder,
  getProjectMarkerStatus,
  resolveMarkedFolder,
  setMarkerKeptInGit,
  writeProjectMarkers,
  type ProjectMarkerStatus
} from './project-folder-marker'
import {
  findProjectFolderMapping,
  getProjectFolderMapping,
  isProjectFolderDiscoveryBlocked,
  setProjectFolderMapping,
  removeProjectFolderMapping
} from './project-folder-mappings'
import { explicitAssignmentSessionIds } from './session-history'
import {
  confirmRootCommitSuggestion,
  holdForRootCommitMatch,
  openRootCommitSuggestion,
  openRootCommitSuggestions,
  recordRootCommits,
  settleRootCommitSuggestion
} from './project-root-commit'
import {
  journalDirectoryCreate,
  journalDirectoryDelete,
  journalDirectoryEdit
} from './folder-sync-directory-local'
import {
  UNASSIGNED_CLIENT_COLOR,
  UNASSIGNED_CLIENT_NAME,
  UNASSIGNED_CLIENT_ROLE
} from './folder-sync-builtin-client'
import {
  assertFreshSyncEdit,
  readSyncEditVersion,
  type SyncEditTarget
} from './folder-sync-edit-version'
import { AppError } from '../../shared/types/ipc'
import { CLIENT_COLORS } from '../../shared/types/client-project'
import { normalizePath, getProjectName, isExcludedProjectPath } from '../../shared/paths'
import type {
  Client,
  NewClient,
  UpdateClient,
  MarkedFolderEvent,
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
    updatedAt: row.updatedAt,
    systemRole: row.systemRole ?? null,
    ...syncVersionOf({ kind: 'client', id: row.id })
  }
}

function syncVersionOf(target: SyncEditTarget): { syncVersion?: string } {
  const syncVersion = readSyncEditVersion(getDb(), target)
  return syncVersion === undefined ? {} : { syncVersion }
}

/** User editors pass requireSyncVersion; internal automatic writes do not. */
export interface EditFreshnessOptions {
  requireSyncVersion?: boolean
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
    directoryPath:
      getProjectFolderMapping(getDb(), getLocalDeviceSession().deviceId, row.syncId)
        ?.directoryPath ?? null,
    isBillable: row.isBillable,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...syncVersionOf({ kind: 'project', id: row.id })
  }
}

/** Told about projects discovery creates later, after a git-history check released a folder. */
let discoveredProjectListener: ((project: Project) => void) | undefined
const RELEASE_BATCH_MS = 1000
const releasedFolders = new Set<string>()
let releaseTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Follow-up work once a suggestion is answered. The answer itself stands, so a failure here is
 * reported under a code the renderer does not ask again for.
 */
function afterSettled(work: () => void): void {
  try {
    work()
  } catch (error) {
    log.warn('Follow-up after a folder suggestion failed:', error)
    throw new AppError(
      'SUGGESTION_FOLLOW_UP_FAILED',
      `Your answer was saved, but updating sessions failed: ${error instanceof Error ? error.message : String(error)}`
    )
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

    const result = db.transaction((tx) => {
      const client = tx
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
      journalDirectoryCreate(tx, 'client', client.syncId)
      return client
    })

    log.info(`Created client: ${result.name} (id=${result.id})`)
    return toClient(result)
  },

  updateClient(id: number, data: UpdateClient, options: EditFreshnessOptions = {}): Client {
    const db = getDb()
    const existing = db.select().from(clients).where(eq(clients.id, id)).get()
    if (!existing) {
      throw new AppError('CLIENT_NOT_FOUND', `Client with id ${id} not found`)
    }
    // expectedSyncVersion is a precondition, never a column: the set below lists fields explicitly.
    assertFreshSyncEdit(
      db,
      { kind: 'client', id },
      data.expectedSyncVersion,
      options.requireSyncVersion
    )

    const now = new Date().toISOString()
    const result = db.transaction((tx) =>
      journalDirectoryEdit(tx, 'client', existing.syncId, () =>
        tx
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
      )
    )

    log.info(`Updated client: ${result.name} (id=${id})`)
    return toClient(result)
  },

  deleteClient(id: number): void {
    const db = getDb()
    const existing = db.select().from(clients).where(eq(clients.id, id)).get()
    if (!existing) {
      throw new AppError('CLIENT_NOT_FOUND', `Client with id ${id} not found`)
    }
    // Auto-created projects need a target; deactivating it silently would strand them.
    if (existing.systemRole) {
      throw new AppError(
        'CLIENT_BUILT_IN',
        `"${existing.name}" is the built-in client for auto-created projects and cannot be deleted`
      )
    }

    const journaled = db.transaction((tx) => {
      // Synced history records a deletion that only deactivates; nothing cascades.
      if (journalDirectoryDelete(tx, 'client', existing.syncId)) return true

      // Nullify session references for all sessions linked to this client
      // (covers both direct clientId refs and projectId refs via client's projects)
      tx.update(sessions)
        .set({ projectId: null, clientId: null, updatedAt: new Date().toISOString() })
        .where(eq(sessions.clientId, id))
        .run()

      tx.delete(projects).where(eq(projects.clientId, id)).run()
      tx.delete(clients).where(eq(clients.id, id)).run()
      return false
    })

    log.info(
      journaled
        ? `Deactivated synced client id=${id}; its projects and sessions are retained`
        : `Deleted client id=${id} and its projects`
    )
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

  getLocalProjects(): (Project & { directoryPath: string })[] {
    return this.getProjects().filter(
      (project): project is Project & { directoryPath: string } => project.directoryPath !== null
    )
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

    const normalized = mainProjectPath(data.directoryPath)

    // Check if a project with this directory already exists (e.g. under Unassigned)
    // If so, move it to the new client instead of duplicating
    const existing = this.findProjectByDirectory(normalized)
    if (existing) {
      if (existing.clientId === data.clientId) {
        this.writeProjectMarkers([existing.id])
        return existing // already under this client
      }
      const syncId = db
        .select({ syncId: projects.syncId })
        .from(projects)
        .where(eq(projects.id, existing.id))
        .get()!.syncId
      const result = db.transaction((tx) =>
        journalDirectoryEdit(tx, 'project', syncId, () => {
          const moved = tx
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
          journalSessionMutations(
            tx,
            tx
              .select({ id: sessions.id })
              .from(sessions)
              .where(and(eq(sessions.projectId, existing.id), activeSessionCondition))
              .all()
              .map((row) => row.id),
            () => {
              tx.update(sessions)
                .set({ clientId: data.clientId, updatedAt: now })
                .where(and(eq(sessions.projectId, existing.id), activeSessionCondition))
                .run()
            }
          )
          return moved
        })
      )

      log.info(
        `Moved project: ${result.name} (id=${existing.id}) from client ${existing.clientId} to ${data.clientId}`
      )
      this.writeProjectMarkers([existing.id])
      return toProject(result)
    }

    const result = db.transaction((tx) => {
      const project = tx
        .insert(projects)
        .values({
          clientId: data.clientId,
          name: data.name,
          isBillable: data.isBillable ?? true,
          stageName: data.stageName ?? null,
          hourlyRate: data.hourlyRate ?? null,
          createdAt: now,
          updatedAt: now
        })
        .returning()
        .get()
      setProjectFolderMapping(tx, getLocalDeviceSession().deviceId, project.syncId, normalized)
      journalDirectoryCreate(tx, 'project', project.syncId)
      return project
    })

    log.info(`Created project: ${result.name} (id=${result.id}, client=${data.clientId})`)
    this.writeProjectMarkers([result.id])
    return toProject(result)
  },

  updateProject(id: number, data: UpdateProject, options: EditFreshnessOptions = {}): Project {
    const db = getDb()
    const existing = db.select().from(projects).where(eq(projects.id, id)).get()
    if (!existing) {
      throw new AppError('PROJECT_NOT_FOUND', `Project with id ${id} not found`)
    }
    // expectedSyncVersion is a precondition, never a column: values below list fields explicitly.
    assertFreshSyncEdit(
      db,
      { kind: 'project', id },
      data.expectedSyncVersion,
      options.requireSyncVersion
    )

    if (data.clientId !== undefined) {
      const client = db.select().from(clients).where(eq(clients.id, data.clientId)).get()
      if (!client) {
        throw new AppError('CLIENT_NOT_FOUND', `Client with id ${data.clientId} not found`)
      }
    }

    const now = new Date().toISOString()
    // Only portable fields are journaled; this computer's folder mapping stays local.
    const result = db.transaction((tx) =>
      journalDirectoryEdit(tx, 'project', existing.syncId, () => {
        if (data.directoryPath !== undefined) {
          if (data.directoryPath === null) {
            removeProjectFolderMapping(tx, getLocalDeviceSession().deviceId, existing.syncId)
          } else {
            setProjectFolderMapping(
              tx,
              getLocalDeviceSession().deviceId,
              existing.syncId,
              data.directoryPath
            )
          }
        }
        const values = {
          ...(data.name !== undefined && data.name !== existing.name && { name: data.name }),
          ...(data.invoiceName !== undefined &&
            data.invoiceName !== existing.invoiceName && { invoiceName: data.invoiceName }),
          ...(data.stageName !== undefined &&
            data.stageName !== existing.stageName && { stageName: data.stageName }),
          ...(data.hourlyRate !== undefined &&
            data.hourlyRate !== existing.hourlyRate && { hourlyRate: data.hourlyRate }),
          ...(data.isBillable !== undefined &&
            data.isBillable !== existing.isBillable && { isBillable: data.isBillable }),
          ...(data.isActive !== undefined &&
            data.isActive !== existing.isActive && { isActive: data.isActive }),
          ...(data.clientId !== undefined &&
            data.clientId !== existing.clientId && { clientId: data.clientId })
        }
        const result = Object.keys(values).length
          ? tx
              .update(projects)
              .set({ ...values, updatedAt: now })
              .where(eq(projects.id, id))
              .returning()
              .get()
          : existing

        // If client changed, update all sessions for this project too
        if (data.clientId !== undefined && data.clientId !== existing.clientId) {
          journalSessionMutations(
            tx,
            tx
              .select({ id: sessions.id })
              .from(sessions)
              .where(and(eq(sessions.projectId, id), activeSessionCondition))
              .all()
              .map((row) => row.id),
            () => {
              tx.update(sessions)
                .set({ clientId: data.clientId, updatedAt: now })
                .where(and(eq(sessions.projectId, id), activeSessionCondition))
                .run()
            }
          )
          log.info(
            `Moved project: ${result.name} (id=${id}) from client ${existing.clientId} to ${data.clientId}`
          )
        } else {
          log.info(`Updated project: ${result.name} (id=${id})`)
        }

        return result
      })
    )
    // A newly linked folder, or a project moved out of Unassigned, gets its marker now.
    this.writeProjectMarkers([id])
    return toProject(result)
  },

  /** Write markers for this computer's assigned project folders (all, or only `projectIds`). */
  writeProjectMarkers(projectIds?: number[]): number {
    const db = getDb()
    const syncIds = projectIds?.flatMap((projectId) => {
      const row = db
        .select({ syncId: projects.syncId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .get()
      return row ? [row.syncId] : []
    })
    const { deviceId } = getLocalDeviceSession()
    // The same moments a folder becomes known: also record its git history for clones.
    void recordRootCommits(db, deviceId, syncIds).catch((error) =>
      log.warn('Recording git root commits failed:', error)
    )
    return writeProjectMarkers(db, deviceId, syncIds)
  },

  setDiscoveredProjectListener(next: ((project: Project) => void) | undefined): void {
    discoveredProjectListener = next
  },

  /** Root-commit suggestions waiting for an answer (the renderer shows them again on reload). */
  getFolderSuggestions(): MarkedFolderEvent[] {
    return openRootCommitSuggestions()
  },

  /** Accept a root-commit suggestion: use this folder for the project on this computer. */
  linkSuggestedFolder(projectId: number, directoryPath: string): void {
    const db = getDb()
    const { deviceId } = getLocalDeviceSession()
    let confirmed: ReturnType<typeof confirmRootCommitSuggestion>
    try {
      confirmed = confirmRootCommitSuggestion(db, deviceId, directoryPath, projectId)
    } catch (error) {
      // An outdated suggestion no longer holds the folder; discover it as before.
      if (error instanceof AppError && error.code === 'SUGGESTION_OUTDATED') {
        try {
          this._discoverReleasedFolders([directoryPath])
        } catch (discoverError) {
          log.warn(`Discovering ${directoryPath} failed:`, discoverError)
        }
      }
      throw error
    }
    const { project, directoryPath: folder } = confirmed
    setProjectFolderMapping(db, deviceId, project.syncId, folder)
    settleRootCommitSuggestion(folder)
    log.info(`Linked ${folder} to ${project.name} by its git history`)
    afterSettled(() => {
      this.attributeSessions()
      this.writeProjectMarkers([projectId])
    })
  },

  /** Decline a root-commit suggestion: discover the folder as its own project, as before. */
  declineSuggestedFolder(directoryPath: string): void {
    const folder = openRootCommitSuggestion(directoryPath)
    if (!folder) {
      throw new AppError('SUGGESTION_NOT_FOUND', `No link suggestion is open for ${directoryPath}`)
    }
    settleRootCommitSuggestion(folder)
    afterSettled(() => this._discoverReleasedFolders([folder]))
  },

  /** A folder released by its git check; batched so many releases attribute sessions once. */
  _queueReleasedFolder(directoryPath: string): void {
    releasedFolders.add(directoryPath)
    releaseTimer ??= setTimeout(() => {
      releaseTimer = undefined
      const folders = [...releasedFolders]
      releasedFolders.clear()
      try {
        this._discoverReleasedFolders(folders)
      } catch (error) {
        log.warn('Discovering released folders failed:', error)
      }
    }, RELEASE_BATCH_MS)
  },

  /** Create the projects discovery held back, and tell the watcher as discovery would have. */
  _discoverReleasedFolders(directoryPaths: string[]): void {
    const created = directoryPaths.flatMap((path) => this.autoCreateProject(path) ?? [])
    if (!created.length) return
    this.attributeSessions()
    for (const project of created) discoveredProjectListener?.(project)
  },

  getProjectMarkerStatus(id: number): ProjectMarkerStatus | null {
    const directory = this.getProjectById(id)?.directoryPath
    return directory ? getProjectMarkerStatus(directory) : null
  },

  setProjectMarkerInGit(id: number, keep: boolean): ProjectMarkerStatus | null {
    const directory = this.getProjectById(id)?.directoryPath
    if (!directory) return null
    setMarkerKeptInGit(directory, keep)
    return getProjectMarkerStatus(directory)
  },

  deleteProject(id: number): void {
    const db = getDb()
    const existing = db.select().from(projects).where(eq(projects.id, id)).get()
    if (!existing) {
      throw new AppError('PROJECT_NOT_FOUND', `Project with id ${id} not found`)
    }

    const journaled = db.transaction((tx) => {
      // Synced history records a deletion that only deactivates; sessions keep their project.
      if (journalDirectoryDelete(tx, 'project', existing.syncId)) return true

      tx.update(sessions)
        .set({ projectId: null, clientId: null, updatedAt: new Date().toISOString() })
        .where(eq(sessions.projectId, id))
        .run()

      tx.delete(projects).where(eq(projects.id, id)).run()
      return false
    })

    log.info(journaled ? `Deactivated synced project id=${id}` : `Deleted project id=${id}`)
  },

  // ── Auto-Detection ──

  getOrCreateUnassignedClient(): Client {
    const db = getDb()
    const builtIn = (): typeof clients.$inferSelect | undefined =>
      db.select().from(clients).where(eq(clients.systemRole, UNASSIGNED_CLIENT_ROLE)).get()
    const existing = builtIn()
    if (existing) return toClient(existing)

    // The role, not the name, identifies the built-in: an ordinary client already called
    // "Unassigned" keeps its identity and the built-in takes the next free name.
    const taken = new Set(
      db
        .select({ name: clients.name })
        .from(clients)
        .all()
        .map((row) => row.name)
    )
    let name = UNASSIGNED_CLIENT_NAME
    for (let suffix = 2; taken.has(name); suffix++) name = `${UNASSIGNED_CLIENT_NAME} ${suffix}`

    const now = new Date().toISOString()
    try {
      // The local syncId stays random; sync shares the built-in under its reserved portable ID.
      const result = db.transaction((tx) => {
        const client = tx
          .insert(clients)
          .values({
            name,
            systemRole: UNASSIGNED_CLIENT_ROLE,
            color: UNASSIGNED_CLIENT_COLOR,
            createdAt: now,
            updatedAt: now
          })
          .returning()
          .get()
        journalDirectoryCreate(tx, 'client', client.syncId)
        return client
      })

      log.info(`Created built-in "${name}" client (id=${result.id})`)
      return toClient(result)
    } catch (err: unknown) {
      // UNIQUE constraint race — re-query
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        const row = builtIn()
        if (row) return toClient(row)
      }
      throw err
    }
  },

  autoCreateProject(directoryPath: string): Project | null {
    if (!isLocalProjectSetupComplete()) return null
    if (isExcludedProjectPath(directoryPath)) return null
    directoryPath = mainProjectPath(directoryPath)
    // A worktree also inherits exclusions on its main project.
    if (isExcludedProjectPath(directoryPath)) return null
    const existing = this.findProjectByDirectory(directoryPath)
    if (existing) return null

    try {
      if (
        isProjectFolderDiscoveryBlocked(getDb(), getLocalDeviceSession().deviceId, directoryPath)
      ) {
        return null
      }
      // A marked folder links to (or is a copy of) its existing project, never a new one.
      if (resolveMarkedFolder(getDb(), getLocalDeviceSession().deviceId, directoryPath)) return null
      // An unmarked folder may share a known project's git history; ask before creating one.
      const held = holdForRootCommitMatch(
        getDb(),
        getLocalDeviceSession().deviceId,
        directoryPath,
        emitMarkedFolder,
        (released) => this._queueReleasedFolder(released)
      )
      if (held) return null
    } catch (error) {
      if (error instanceof AppError && error.code === 'INVALID_PROJECT_FOLDER') return null
      throw error
    }

    const unassigned = this.getOrCreateUnassignedClient()
    const name = getProjectName(directoryPath)
    const normalized = normalizePath(directoryPath)
    const now = new Date().toISOString()

    try {
      const db = getDb()
      const result = db.transaction((tx) => {
        const project = tx
          .insert(projects)
          .values({
            clientId: unassigned.id,
            name,
            isBillable: false,
            createdAt: now,
            updatedAt: now
          })
          .returning()
          .get()
        setProjectFolderMapping(tx, getLocalDeviceSession().deviceId, project.syncId, normalized)
        journalDirectoryCreate(tx, 'project', project.syncId)
        return project
      })

      log.info(`Auto-created project: ${name} (id=${result.id}) under Unassigned`)
      return toProject(result)
    } catch (err: unknown) {
      // UNIQUE constraint race condition — project was created between check and insert
      if (err instanceof AppError && err.code === 'INVALID_PROJECT_FOLDER') return null
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        log.debug(`autoCreateProject: UNIQUE conflict for ${normalized}, already exists`)
        return null
      }
      throw err
    }
  },

  /** Local exclusions must not delete portable project identities. */
  purgeExcludedProjects(): number {
    return 0
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
    return this.getProjects().flatMap((p) =>
      !p.isActive && p.directoryPath ? [p.directoryPath.toLowerCase()] : []
    )
  },

  // ── Directory Mapping ──

  /** Link or move a folder carrying a known project's marker. True when it is now mapped. */
  resolveMarkedFolder(directoryPath: string): boolean {
    try {
      const marked = resolveMarkedFolder(getDb(), getLocalDeviceSession().deviceId, directoryPath)
      return marked?.kind === 'linked' || marked?.kind === 'moved'
    } catch (error) {
      if (error instanceof AppError && error.code === 'INVALID_PROJECT_FOLDER') return false
      throw error
    }
  },

  findProjectByDirectory(directoryPath: string): Project | null {
    const db = getDb()
    let mapping: ReturnType<typeof findProjectFolderMapping>
    try {
      mapping = findProjectFolderMapping(db, getLocalDeviceSession().deviceId, directoryPath)
    } catch (error) {
      // Missing/invalid legacy or provider paths cannot claim a local mapping.
      if (error instanceof AppError && error.code === 'INVALID_PROJECT_FOLDER') return null
      throw error
    }
    const match = mapping
      ? db.select().from(projects).where(eq(projects.syncId, mapping.projectSyncId)).get()
      : null
    return match ? toProject(match) : null
  },

  /** Attribute only unassigned work using this computer's current mappings. */
  attributeSessions(): number {
    const db = getDb()
    const explicitAssignments = explicitAssignmentSessionIds(db)
    const candidates = db
      .select()
      .from(sessions)
      .where(activeSessionCondition)
      .all()
      .filter((session) => session.projectId == null && !explicitAssignments.has(session.id))
    let count = 0
    db.transaction((tx) => {
      for (const session of candidates) {
        const canonical = mainProjectPath(session.projectPath)
        if (canonical !== normalizePath(session.projectPath)) this.autoCreateProject(canonical)
        let match = this.findProjectByDirectory(session.projectPath)
        if (!match && this.resolveMarkedFolder(session.projectPath)) {
          match = this.findProjectByDirectory(session.projectPath)
        }
        if (!match) continue
        journalSessionMutations(tx, [session.id], () => {
          tx.update(sessions)
            .set({
              projectId: match.id,
              clientId: match.clientId,
              updatedAt: new Date().toISOString()
            })
            .where(eq(sessions.id, session.id))
            .run()
        })
        count++
      }
    })
    log.info(`Attributed ${count} sessions to projects`)
    return count
  }
}
