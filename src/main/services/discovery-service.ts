import { readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import log from 'electron-log/main.js'
import {
  isExcludedProjectDir,
  isExcludedProjectPath,
  normalizePath,
  getProjectName
} from '../../shared/paths'
import { codexProvider } from '../providers/codex-provider'
import { geminiProvider } from '../providers/gemini-provider'
import { opencodeProvider } from '../providers/opencode-provider'
import { encodeProjectPath } from './session-detector'
import { isProviderEnabled } from './provider-tracking'
import type { SessionProvider } from '../providers/types'
import type { DiscoveredProject } from '../../shared/types/session'

/**
 * DiscoveryService finds all tracked coding-agent projects:
 * - Claude Code stores project data centrally at ~/.claude/projects/{encoded-path}/
 * - Codex, Gemini CLI, and OpenCode have no such central per-project tree; their
 *   projects come from each session's cwd via the provider's cheap meta read.
 *
 * Imported individually (not via the registry) to avoid a module cycle:
 * providers/index → claude-provider → this file.
 */
const CWD_PROVIDERS: SessionProvider[] = [codexProvider, geminiProvider, opencodeProvider]

export const discoveryService = {
  /**
   * Discover all projects from every ~/.claude* profile plus every cwd-based
   * provider's session store.
   */
  async discoverDefaultProjects(): Promise<DiscoveredProject[]> {
    const projects = await readClaudeProjects()
    return mergeProviderProjects(projects)
  },

  /**
   * Discover projects filtered to only those whose decoded path starts with
   * the given folder.
   */
  async discoverProjectsUnderFolder(folder: string): Promise<DiscoveredProject[]> {
    const all = await mergeProviderProjects(await readClaudeProjects())
    const normalized = folder.replace(/\\/g, '/').toLowerCase()
    return all.filter((p) => p.projectPath.replace(/\\/g, '/').toLowerCase().startsWith(normalized))
  }
}

/** Add non-Claude projects (grouped by each session's cwd) to a discovery result. */
async function mergeProviderProjects(projects: DiscoveredProject[]): Promise<DiscoveredProject[]> {
  const byEncodedName = new Map(projects.map((p) => [p.encodedName, p]))

  for (const provider of CWD_PROVIDERS) {
    if (!isProviderEnabled(provider.id)) continue

    let files: string[]
    try {
      files = await provider.discoverFiles()
    } catch {
      continue
    }

    // Read every file's meta concurrently — each is an independent cheap head
    // read, so a serial await per file makes project-list refresh O(N) on the
    // main process. Results are folded in deterministically afterward.
    const metas = await Promise.all(files.map((file) => provider.readMeta(file).catch(() => null)))

    let added = 0
    for (const meta of metas) {
      if (!meta?.cwd) continue
      const projectPath = normalizePath(meta.cwd)
      if (isExcludedProjectPath(projectPath)) continue
      const encodedName = encodeProjectPath(projectPath)
      if (byEncodedName.has(encodedName)) continue
      byEncodedName.set(encodedName, {
        projectPath,
        projectName: getProjectName(projectPath),
        encodedName,
        hasClaudeDir: false
      })
      added++
    }
    if (added > 0) log.info(`Discovery: found ${added} ${provider.id}-only project(s)`)
  }

  return [...byEncodedName.values()]
}

/**
 * Resolve every Claude config directory to scan. Claude Code stores sessions
 * under CLAUDE_CONFIG_DIR, and users who juggle multiple accounts point it at
 * sibling dirs like ~/.claude-vss or ~/.claude-feature23. We enumerate every
 * ~/.claude* folder that actually has a projects/ subdir so switching accounts
 * doesn't silently stop tracking. Returns [~/.claude] as a fallback.
 */
export async function getClaudeConfigDirs(): Promise<string[]> {
  const home = homedir()
  const fallback = join(home, '.claude')

  let entries: import('node:fs').Dirent<string>[]
  try {
    entries = await readdir(home, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return [fallback]
  }

  const dirs: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name !== '.claude' && !entry.name.startsWith('.claude-')) continue
    const base = join(home, entry.name)
    try {
      // Only include profiles that actually hold session data.
      await readdir(join(base, 'projects'))
      dirs.push(base)
    } catch {
      // No projects/ subdir — not a session-bearing profile, skip.
    }
  }

  return dirs.length > 0 ? dirs : [fallback]
}

async function readClaudeProjects(): Promise<DiscoveredProject[]> {
  const configDirs = await getClaudeConfigDirs()
  const byEncodedName = new Map<string, DiscoveredProject>()

  for (const configDir of configDirs) {
    const projectsDir = join(configDir, 'projects')
    log.info(`Discovery: reading projects from: ${projectsDir}`)
    try {
      const entries = await readdir(projectsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (isExcludedProjectDir(entry.name)) continue
        const encodedName = entry.name
        if (byEncodedName.has(encodedName)) continue
        const projectPath = decodeProjectName(encodedName)
        byEncodedName.set(encodedName, {
          projectPath,
          projectName: basename(projectPath) || encodedName,
          encodedName,
          hasClaudeDir: true
        })
      }
    } catch {
      log.warn(`Discovery: ${projectsDir} not found or inaccessible`)
    }
  }

  const projects = [...byEncodedName.values()]
  log.info(`Discovery: found ${projects.length} projects across ${configDirs.length} config dir(s)`)
  return projects
}

/**
 * Decode a .claude/projects/ folder name back to a project path.
 * Claude CLI encodes paths by replacing `:`, `\`, and `/` with `-`.
 * Example: "C--apps-ClauTime" → "C:\apps\ClauTime" (Windows)
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
