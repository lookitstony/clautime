import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { gitCommits } from '../db/schema/git-commits'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { settingsService } from './settings-service'
import type { UnconfiguredAuthor } from '../../shared/types/git'

const execFileAsync = promisify(execFile)
const BATCH_SIZE = 100

interface ParsedCommit {
  hash: string
  message: string
  authorName: string
  authorEmail: string
  committedAt: string
}

/**
 * GitService reads git commit history from project directories
 * and correlates commits with sessions.
 */
export const gitService = {
  // isGitRepo results cached briefly. Scans hit every project repeatedly, and
  // each non-repo directory otherwise costs a `git rev-parse` process spawn —
  // spawn setup runs synchronously on the main thread and was profiled as the
  // dominant cause of UI freezes when scans fired every few seconds.
  _repoCheckCache: new Map<string, { at: number; isRepo: boolean }>(),
  _REPO_CHECK_TTL_MS: 10 * 60_000,
  _utcNormalized: false,

  /**
   * Check if git is available on the system.
   */
  async isGitAvailable(): Promise<boolean> {
    try {
      await execFileAsync('git', ['--version'])
      return true
    } catch {
      return false
    }
  },

  /**
   * Check if a directory is a git repository.
   */
  async isGitRepo(dirPath: string): Promise<boolean> {
    const cached = this._repoCheckCache.get(dirPath)
    if (cached && Date.now() - cached.at < this._REPO_CHECK_TTL_MS) return cached.isRepo

    let isRepo: boolean
    try {
      await access(join(dirPath, '.git'), constants.R_OK)
      isRepo = true
    } catch {
      // Also try git rev-parse as fallback (works in subdirs)
      try {
        await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: dirPath })
        isRepo = true
      } catch {
        isRepo = false
      }
    }
    this._repoCheckCache.set(dirPath, { at: Date.now(), isRepo })
    return isRepo
  },

  /**
   * Read git commits from a project directory.
   * Returns parsed commit objects.
   */
  async readCommits(
    dirPath: string,
    since?: string,
    authorEmails?: string[],
    opts?: { assumeRepo?: boolean }
  ): Promise<ParsedCommit[]> {
    if (!opts?.assumeRepo) {
      const isRepo = await this.isGitRepo(dirPath)
      if (!isRepo) {
        log.warn(`Not a git repository: ${dirPath}`)
        return []
      }
    }

    const args = ['log', '--branches', '--format=%H|%s|%an|%ae|%aI', '--no-merges']

    if (since) {
      args.push(`--since=${since}`)
    }

    // Multiple --author flags are ORed together by git
    if (authorEmails && authorEmails.length > 0) {
      for (const email of authorEmails) {
        args.push(`--author=${email}`)
      }
    }

    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: dirPath,
        maxBuffer: 10 * 1024 * 1024 // 10MB
      })

      if (!stdout.trim()) return []

      return stdout
        .trim()
        .split('\n')
        .map((line) => {
          const [hash, message, authorName, authorEmail, committedAt] = line.split('|')
          // Normalize to UTC ISO string for consistent date comparisons
          const utcCommittedAt = committedAt ? new Date(committedAt).toISOString() : ''
          return { hash, message, authorName, authorEmail, committedAt: utcCommittedAt }
        })
        .filter((c) => c.hash && c.committedAt)
    } catch (error) {
      log.warn(`Failed to read git log from ${dirPath}:`, error)
      return []
    }
  },

  /**
   * Auto-detect the user's git identity from git config.
   * If dirPath is provided, uses the local repo config (falls back to global).
   */
  async detectGitIdentity(dirPath?: string): Promise<{ name: string; email: string } | null> {
    try {
      const opts = dirPath
        ? { cwd: dirPath, encoding: 'utf8' as const }
        : { encoding: 'utf8' as const }
      const [nameResult, emailResult] = await Promise.all([
        execFileAsync('git', ['config', 'user.name'], opts),
        execFileAsync('git', ['config', 'user.email'], opts)
      ])
      return {
        name: nameResult.stdout.trim(),
        email: emailResult.stdout.trim()
      }
    } catch {
      log.warn(
        `Could not detect git identity${dirPath ? ` for ${dirPath}` : ' from global config'}`
      )
      return null
    }
  },

  /**
   * Get the configured git identity for a project directory.
   * Priority: per-repo local git config → app settings → global git config.
   */
  async getGitIdentity(dirPath?: string): Promise<{ name: string; email: string } | null> {
    // Try per-repo identity first (respects local .git/config)
    if (dirPath) {
      const local = await this.detectGitIdentity(dirPath)
      if (local?.name && local?.email) return local
    }
    // Fall back to app settings
    const name = settingsService.getSetting('git_author_name')
    const email = settingsService.getSetting('git_author_email')
    if (name && email) return { name, email }
    // Fall back to global git config
    return this.detectGitIdentity()
  },

  /**
   * Resolve the list of author emails to filter commits by, for a given project.
   * App setting `git_author_email` may hold a comma-separated list to support
   * a single contributor who commits under multiple identities (e.g. personal
   * + work email). Falls back to per-repo or global git config (single email)
   * when the setting is empty.
   */
  async getGitAuthorEmails(dirPath?: string): Promise<string[]> {
    const setting = settingsService.getSetting('git_author_email')
    if (setting) {
      const emails = setting
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e.length > 0)
      if (emails.length > 0) return emails
    }
    // Fall back to git-config-derived single email
    const identity = await this.getGitIdentity(dirPath)
    return identity?.email ? [identity.email] : []
  },

  /**
   * Find author emails that appear in project repos (last 90 days) but are NOT
   * in the configured filter list for that repo — i.e. commits the scan would
   * silently skip. Excludes bot authors and emails the user has chosen to
   * ignore (`git_ignored_author_emails` setting). Returns emails sorted by
   * how many commits they account for. Used to prompt the user to add an
   * email after they change their git identity (e.g. to a GitHub noreply).
   */
  async findUnconfiguredAuthorEmails(): Promise<UnconfiguredAuthor[]> {
    const gitAvailable = await this.isGitAvailable()
    if (!gitAvailable) return []

    const ignoredRaw = settingsService.getSetting('git_ignored_author_emails') ?? ''
    const ignored = new Set(
      ignoredRaw
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0)
    )

    const db = getDb()
    const allProjects = db.select().from(projects).all()
    const found = new Map<string, UnconfiguredAuthor>()

    for (const project of allProjects) {
      if (!(await this.isGitRepo(project.directoryPath))) continue

      // Compare against the SAME emails the scan filters this repo by, so an
      // "unconfigured" email is precisely one whose commits would be dropped.
      const configured = new Set(
        (await this.getGitAuthorEmails(project.directoryPath)).map((e) => e.toLowerCase())
      )

      try {
        const { stdout } = await execFileAsync(
          'git',
          ['log', '--branches', '--no-merges', '--since=90 days ago', '--format=%ae|%an'],
          { cwd: project.directoryPath, maxBuffer: 10 * 1024 * 1024 }
        )
        for (const line of stdout.trim().split('\n')) {
          if (!line) continue
          const sep = line.indexOf('|')
          const email = (sep >= 0 ? line.slice(0, sep) : line).trim()
          const name = sep >= 0 ? line.slice(sep + 1).trim() : ''
          if (!email) continue
          const key = email.toLowerCase()
          if (configured.has(key) || ignored.has(key)) continue
          if (key.includes('[bot]')) continue // dependabot[bot] etc.
          const existing = found.get(key)
          if (existing) existing.count++
          else found.set(key, { email, name, count: 1 })
        }
      } catch (error) {
        log.warn(`Failed to read authors from ${project.directoryPath}:`, error)
      }
    }

    return [...found.values()].sort((a, b) => b.count - a.count)
  },

  /**
   * Scan commits for all projects and store in DB.
   * Processes in batches.
   */
  async scanCommits(
    projectFilter?: number[]
  ): Promise<{ newCommits: number; projectsScanned: number }> {
    const gitAvailable = await this.isGitAvailable()
    if (!gitAvailable) {
      log.warn('Git is not available on this system')
      return { newCommits: 0, projectsScanned: 0 }
    }

    const db = getDb()

    // One-time per app run: normalize committedAt values with timezone offsets
    if (!this._utcNormalized) {
      this._utcNormalized = true
      const nonUtcCommits = db
        .select()
        .from(gitCommits)
        .all()
        .filter((c) => c.committedAt && !c.committedAt.endsWith('Z'))
      if (nonUtcCommits.length > 0) {
        log.info(`Normalizing ${nonUtcCommits.length} commit timestamps to UTC`)
        for (const c of nonUtcCommits) {
          db.update(gitCommits)
            .set({ committedAt: new Date(c.committedAt).toISOString() })
            .where(eq(gitCommits.id, c.id))
            .run()
        }
      }
    }

    const allProjects = db.select().from(projects).all()
    const targetProjects = projectFilter
      ? allProjects.filter((p) => projectFilter.includes(p.id))
      : allProjects

    let totalNewCommits = 0
    let projectsScanned = 0

    for (const project of targetProjects) {
      try {
        const isRepo = await this.isGitRepo(project.directoryPath)
        if (!isRepo) continue

        projectsScanned++
        const authorEmails = await this.getGitAuthorEmails(project.directoryPath)
        // Incremental: read only history since just before the newest stored
        // commit (7-day overlap absorbs clock skew and rebases; hash dedup
        // below drops the overlap). Full history only for first-time projects.
        const newest = db
          .select({ max: sql<string | null>`max(${gitCommits.committedAt})` })
          .from(gitCommits)
          .where(eq(gitCommits.projectId, project.id))
          .get()
        const since = newest?.max
          ? new Date(Date.parse(newest.max) - 7 * 86_400_000).toISOString()
          : undefined
        const commits = await this.readCommits(project.directoryPath, since, authorEmails, {
          assumeRepo: true
        })

        if (commits.length === 0) continue

        // Get existing commit hashes for this project
        const existingHashes = new Set(
          db
            .select({ hash: gitCommits.hash })
            .from(gitCommits)
            .where(eq(gitCommits.projectId, project.id))
            .all()
            .map((r) => r.hash)
        )

        // Filter to only new commits
        const newCommits = commits.filter((c) => !existingHashes.has(c.hash))
        if (newCommits.length === 0) continue

        // Batch insert
        const now = new Date().toISOString()
        for (let i = 0; i < newCommits.length; i += BATCH_SIZE) {
          const batch = newCommits.slice(i, i + BATCH_SIZE)
          db.insert(gitCommits)
            .values(
              batch.map((c) => ({
                projectId: project.id,
                hash: c.hash,
                message: c.message,
                authorName: c.authorName,
                authorEmail: c.authorEmail,
                committedAt: c.committedAt,
                createdAt: now
              }))
            )
            .run()
        }

        totalNewCommits += newCommits.length
        log.info(`Stored ${newCommits.length} new commits for project ${project.name}`)
      } catch (error) {
        log.warn(`Failed to scan commits for project ${project.name}:`, error)
      }
    }

    return { newCommits: totalNewCommits, projectsScanned }
  },

  /**
   * Correlate commits with sessions based on timestamp overlap.
   * A commit is matched to a session if its committed_at falls within
   * the session's start–end range.
   */
  correlateCommitsWithSessions(): number {
    const db = getDb()
    const allSessions = db.select().from(sessions).all()

    // Build a set of valid session IDs for stale detection
    const validSessionIds = new Set(allSessions.map((s) => s.id))

    // Reset stale correlations (sessionId points to a deleted/recreated session)
    const allCommits = db.select().from(gitCommits).all()
    for (const commit of allCommits) {
      if (commit.sessionId != null && !validSessionIds.has(commit.sessionId)) {
        db.update(gitCommits).set({ sessionId: null }).where(eq(gitCommits.id, commit.id)).run()
      }
    }

    // Re-fetch after cleanup
    const uncorrelated = db
      .select()
      .from(gitCommits)
      .all()
      .filter((c) => c.sessionId == null)
    let correlated = 0

    // 5-minute buffer: commits often happen shortly after a session ends
    const BUFFER_MS = 5 * 60 * 1000

    for (const commit of uncorrelated) {
      const commitTime = new Date(commit.committedAt).getTime()

      const matchingSession = allSessions.find((s) => {
        if (s.projectId !== commit.projectId) return false
        const startMs = new Date(s.startedAt).getTime()
        const endMs = new Date(s.endedAt).getTime() + BUFFER_MS
        return commitTime >= startMs && commitTime <= endMs
      })

      if (matchingSession) {
        db.update(gitCommits)
          .set({ sessionId: matchingSession.id })
          .where(eq(gitCommits.id, commit.id))
          .run()
        correlated++
      }
    }

    return correlated
  },

  /**
   * Get commits correlated with a specific session.
   */
  getCommitsForSession(sessionId: number) {
    const db = getDb()
    return db
      .select()
      .from(gitCommits)
      .where(eq(gitCommits.sessionId, sessionId))
      .orderBy(gitCommits.committedAt)
      .all()
  },

  /**
   * Get all commits for a project.
   */
  getCommitsForProject(projectId: number) {
    const db = getDb()
    return db
      .select()
      .from(gitCommits)
      .where(eq(gitCommits.projectId, projectId))
      .orderBy(gitCommits.committedAt)
      .all()
  },

  /**
   * Get the GitHub/remote HTTPS URL for a project directory.
   * Converts SSH and git:// URLs to HTTPS. Returns null if not a git repo or no remote.
   */
  async getRemoteUrl(dirPath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd: dirPath
      })
      const raw = stdout.trim()
      if (!raw) return null
      // Normalize SSH (git@github.com:user/repo.git) to HTTPS
      const sshMatch = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
      if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`
      // Strip .git suffix from HTTPS URLs
      return raw.replace(/\.git$/, '')
    } catch {
      return null
    }
  },

  /**
   * Get the remote URL for a project by its DB ID.
   */
  async getRemoteUrlForProject(projectId: number): Promise<string | null> {
    const db = getDb()
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) return null
    return this.getRemoteUrl(project.directoryPath)
  },

  /**
   * Get set of session IDs that have at least one correlated git commit.
   */
  getSessionIdsWithCommits(): number[] {
    const db = getDb()
    const rows = db.selectDistinct({ sessionId: gitCommits.sessionId }).from(gitCommits).all()
    return rows
      .filter((r): r is { sessionId: number } => r.sessionId != null)
      .map((r) => r.sessionId)
  }
}
