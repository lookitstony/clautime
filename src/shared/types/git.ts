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
