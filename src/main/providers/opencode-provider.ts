import {
  discoverOpencodeSessionFiles,
  readOpencodeSessionMeta,
  parseOpencodeSessionFile,
  getOpencodeStorageDir
} from '../parsers/opencode-parser'
import { encodeProjectPath } from '../services/session-detector'
import { normalizePath, toolForSourceFile } from '../../shared/paths'
import type { SessionProvider, ProviderDiscoverOptions, ProviderSessionMeta } from './types'

/** Case/separator-insensitive "is `filePath` under `root`" test. */
function isUnder(filePath: string, root: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
  return norm(filePath).startsWith(norm(root))
}

/**
 * OpenCode: one session per ses_*.json metadata file under
 * <data-dir>/storage/session/<projectID>/, with messages stored beside it in
 * storage/message/<sessionID>/. Each session's `directory` field is its cwd,
 * so a project filter is matched against that (cheap — metadata files are tiny).
 */
export const opencodeProvider: SessionProvider = {
  id: 'opencode',

  ownsFile(filePath) {
    // The path-substring heuristic covers the default ~/.local/share/opencode
    // layout; also claim files under a custom OPENCODE_DATA_DIR, whose path need
    // not contain the literal "opencode/storage" the heuristic looks for.
    return toolForSourceFile(filePath) === 'opencode' || isUnder(filePath, getOpencodeStorageDir())
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
