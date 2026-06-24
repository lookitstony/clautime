/** Git commit row shape matching the git_commits table schema. */
export interface GitCommit {
  id: number
  projectId: number | null
  hash: string
  message: string
  authorName: string
  authorEmail: string
  committedAt: string
  sessionId: number | null
  createdAt: string
}

/** Result of a git scan operation */
export interface GitScanResult {
  newCommits: number
  projectsScanned: number
  correlated: number
}

/** Git identity (name + email) */
export interface GitIdentity {
  name: string
  email: string
}

/**
 * An author email that appears in project repos but is NOT in the configured
 * scan filter — i.e. commits the scan would silently skip. Surfaced so the
 * user can add the email to their identity.
 */
export interface UnconfiguredAuthor {
  email: string
  name: string
  count: number
}
