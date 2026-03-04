import { readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import log from 'electron-log/main.js'
import type { DiscoveredProject } from '../../shared/types/session'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'out',
  '__pycache__',
  '.venv',
  'venv',
  '.tox'
])

const MAX_DEPTH = 5

/**
 * DiscoveryService finds .claude project directories within a root folder.
 * It scans recursively for .claude/projects/ subdirectories, extracts
 * project names from encoded folder names, and returns DiscoveredProject[].
 */
export const discoveryService = {
  async discoverProjects(rootFolder: string): Promise<DiscoveredProject[]> {
    log.info(`Discovery: scanning for .claude directories under: ${rootFolder}`)
    const projects: DiscoveredProject[] = []
    await scanDirectory(rootFolder, projects, 0)
    log.info(`Discovery: found ${projects.length} projects`)
    return projects
  }
}

async function scanDirectory(
  dir: string,
  results: DiscoveredProject[],
  depth: number
): Promise<void> {
  if (depth > MAX_DEPTH) return

  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // Permission denied or inaccessible — skip silently
    return
  }

  // Check if this directory contains a .claude/projects folder
  const claudeDir = entries.find((e) => e.isDirectory() && e.name === '.claude')
  if (claudeDir) {
    const projectsDir = join(dir, '.claude', 'projects')
    try {
      const projectEntries = await readdir(projectsDir, { withFileTypes: true })
      for (const entry of projectEntries) {
        if (!entry.isDirectory()) continue
        const encodedName = entry.name
        const projectPath = decodeProjectName(encodedName)
        results.push({
          projectPath,
          projectName: basename(projectPath) || encodedName,
          encodedName,
          hasClaudeDir: true
        })
      }
    } catch {
      // .claude exists but no projects subfolder — skip
    }
  }

  // Recurse into subdirectories (skip known non-project dirs)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    if (SKIP_DIRS.has(entry.name)) continue

    await scanDirectory(join(dir, entry.name), results, depth + 1)
  }
}

/**
 * Decode a .claude/projects/ folder name back to a project path.
 * Claude CLI encodes paths by replacing `:`, `\`, and `/` with `-`.
 * Example: "C--apps-ClawdTime" → "C:\apps\ClawdTime" (Windows)
 * Example: "-home-user-projects-myapp" → "/home/user/projects/myapp" (Unix)
 *
 * This is a lossy encoding so we use heuristics:
 * - Letter followed by `--` at start → drive letter (e.g., C:\)
 * - Leading `-` on non-Windows → root `/`
 * - Other `-` → platform path separator
 */
function decodeProjectName(encoded: string): string {
  // Windows drive letter pattern: C--apps-Foo → C:\apps\Foo
  const windowsDriveMatch = encoded.match(/^([A-Za-z])-(-?.*)$/)
  if (windowsDriveMatch) {
    const drive = windowsDriveMatch[1]
    const rest = windowsDriveMatch[2]
    // Replace leading dash (from \) and subsequent dashes with backslash
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
