import { basename } from 'node:path'
import { discoverSessionFiles, parseSessionFile } from '../parsers'
import { getClaudeConfigDirs } from '../services/discovery-service'
import { settingsService } from '../services/settings-service'
import { toolForSourceFile } from '../../shared/paths'
import type { SessionProvider, ProviderDiscoverOptions, ProviderSessionMeta } from './types'

/**
 * Resolve which Claude config dirs to scan. An explicit override (test fixture
 * or a user-set claude_dir) wins and is used alone; otherwise auto-discover
 * every ~/.claude* profile so switching accounts keeps tracking.
 */
async function resolveDirs(rootOverride?: string): Promise<string[]> {
  const override = rootOverride ?? settingsService.getSetting('claude_dir') ?? undefined
  return override ? [override] : getClaudeConfigDirs()
}

/** Claude Code: sessions stored centrally under each ~/.claude* projects tree. */
export const claudeProvider: SessionProvider = {
  id: 'claude',

  ownsFile(filePath) {
    return toolForSourceFile(filePath) === 'claude'
  },

  async discoverFiles(opts?: ProviderDiscoverOptions) {
    const dirs = await resolveDirs(opts?.rootOverride)
    const perDir = await Promise.all(dirs.map((d) => discoverSessionFiles(d, opts?.projectFilter)))
    return perDir.flat()
  },

  async readMeta(filePath): Promise<ProviderSessionMeta> {
    // Claude attributes projects via encoded dir names (handled inside
    // discoverFiles' project filter), so a separate cheap meta read isn't needed
    // for filtering. Derive the id from the filename; cwd comes from a full parse.
    return { sessionId: basename(filePath, '.jsonl'), cwd: null }
  },

  parseFile(filePath, opts) {
    return parseSessionFile(filePath, opts)
  }
}
