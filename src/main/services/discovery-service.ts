import { readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import log from 'electron-log/main.js'
import type { DiscoveredProject } from '../../shared/types/session'

/**
 * DiscoveryService reads ~/.claude/projects/ to find all Claude Code projects.
 * Claude CLI stores all project data centrally at ~/.claude/projects/{encoded-path}/
 */
export const discoveryService = {
  /**
   * Discover all projects from ~/.claude/projects/.
   */
  async discoverDefaultProjects(): Promise<DiscoveredProject[]> {
    return readClaudeProjects()
  },

  /**
   * Discover projects from ~/.claude/projects/ filtered to only those
   * whose decoded path starts with the given folder.
   */
  async discoverProjectsUnderFolder(folder: string): Promise<DiscoveredProject[]> {
    const all = await readClaudeProjects()
    const normalized = folder.replace(/\\/g, '/').toLowerCase()
    return all.filter((p) => p.projectPath.replace(/\\/g, '/').toLowerCase().startsWith(normalized))
  }
}

async function readClaudeProjects(): Promise<DiscoveredProject[]> {
  const projectsDir = join(homedir(), '.claude', 'projects')
  log.info(`Discovery: reading projects from: ${projectsDir}`)
  const projects: DiscoveredProject[] = []

  try {
    const entries = await readdir(projectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const encodedName = entry.name
      const projectPath = decodeProjectName(encodedName)
      projects.push({
        projectPath,
        projectName: basename(projectPath) || encodedName,
        encodedName,
        hasClaudeDir: true
      })
    }
  } catch {
    log.warn('Discovery: ~/.claude/projects not found or inaccessible')
  }

  log.info(`Discovery: found ${projects.length} projects`)
  return projects
}

/**
 * Decode a .claude/projects/ folder name back to a project path.
 * Claude CLI encodes paths by replacing `:`, `\`, and `/` with `-`.
 * Example: "C--apps-ClawdTime" → "C:\apps\ClawdTime" (Windows)
 * Example: "-home-user-projects-myapp" → "/home/user/projects/myapp" (Unix)
 */
function decodeProjectName(encoded: string): string {
  // Windows drive letter pattern: C--apps-Foo → C:\apps\Foo
  const windowsDriveMatch = encoded.match(/^([A-Za-z])-(-?.*)$/)
  if (windowsDriveMatch) {
    const drive = windowsDriveMatch[1]
    const rest = windowsDriveMatch[2]
    const path = rest.replace(/-/g, '\\')
    return `${drive}:${path}`
  }

  // Unix path: leading dash means root /
  if (encoded.startsWith('-')) {
    return encoded.replace(/-/g, '/')
  }

  // Fallback: replace dashes with OS separator
  return encoded.replace(/-/g, '/')
}
