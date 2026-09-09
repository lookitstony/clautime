import { mainProjectPath } from '../services/worktree-paths'
import {
  discoverCodexSessionFiles,
  readCodexSessionMeta,
  parseCodexSessionFile
} from '../parsers/codex-parser'
import { encodeProjectPath } from '../services/session-detector'
import { toolForSourceFile } from '../../shared/paths'
import type { SessionProvider, ProviderDiscoverOptions, ProviderSessionMeta } from './types'

/**
 * OpenAI Codex CLI: one session per rollout file under a date-partitioned tree
 * (~/.codex/sessions/YYYY/MM/DD/). No per-project folders exist, so a project
 * filter is matched against each file's session_meta cwd via a cheap head read.
 */
export const codexProvider: SessionProvider = {
  id: 'codex',

  ownsFile(filePath) {
    return toolForSourceFile(filePath) === 'codex'
  },

  async discoverFiles(opts?: ProviderDiscoverOptions) {
    const files = await discoverCodexSessionFiles(opts?.rootOverride)
    const filter = opts?.projectFilter
    if (!filter || filter.length === 0) return files

    const filterSet = new Set(filter)
    const matched: string[] = []
    for (const f of files) {
      const meta = await readCodexSessionMeta(f)
      if (meta?.cwd && filterSet.has(encodeProjectPath(mainProjectPath(meta.cwd)))) matched.push(f)
    }
    return matched
  },

  async readMeta(filePath): Promise<ProviderSessionMeta | null> {
    return readCodexSessionMeta(filePath)
  },

  parseFile(filePath) {
    return parseCodexSessionFile(filePath)
  }
}
