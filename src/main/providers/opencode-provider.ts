import {
  discoverOpencodeSessionFiles,
  readOpencodeSessionMeta,
  parseOpencodeSessionFile
} from '../parsers/opencode-parser'
import { encodeProjectPath } from '../services/session-detector'
import { normalizePath, toolForSourceFile } from '../../shared/paths'
import type { SessionProvider, ProviderDiscoverOptions, ProviderSessionMeta } from './types'

/**
 * OpenCode: one session per ses_*.json metadata file under
 * <data-dir>/storage/session/<projectID>/, with messages stored beside it in
 * storage/message/<sessionID>/. Each session's `directory` field is its cwd,
 * so a project filter is matched against that (cheap — metadata files are tiny).
 */
export const opencodeProvider: SessionProvider = {
  id: 'opencode',

  ownsFile(filePath) {
    return toolForSourceFile(filePath) === 'opencode'
  },

  async discoverFiles(opts?: ProviderDiscoverOptions) {
    const files = await discoverOpencodeSessionFiles(opts?.rootOverride)
    const filter = opts?.projectFilter
    if (!filter || filter.length === 0) return files

    const filterSet = new Set(filter)
    const matched: string[] = []
    for (const f of files) {
      const meta = await readOpencodeSessionMeta(f)
      if (meta?.cwd && filterSet.has(encodeProjectPath(normalizePath(meta.cwd)))) matched.push(f)
    }
    return matched
  },

  async readMeta(filePath): Promise<ProviderSessionMeta | null> {
    return readOpencodeSessionMeta(filePath)
  },

  parseFile(filePath) {
    return parseOpencodeSessionFile(filePath)
  }
}
