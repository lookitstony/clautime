import {
  discoverGeminiSessionFiles,
  readGeminiSessionMeta,
  parseGeminiSessionFile
} from '../parsers/gemini-parser'
import { encodeProjectPath } from '../services/session-detector'
import { normalizePath, toolForSourceFile } from '../../shared/paths'
import type { SessionProvider, ProviderDiscoverOptions, ProviderSessionMeta } from './types'

/**
 * Google Gemini CLI: one session per JSON recording under
 * ~/.gemini/tmp/<project-dir>/chats/. The project path comes from each
 * project dir's `.project_root` marker (read during the cheap meta pass),
 * so a project filter is matched against that resolved cwd.
 */
export const geminiProvider: SessionProvider = {
  id: 'gemini',

  ownsFile(filePath) {
    return toolForSourceFile(filePath) === 'gemini'
  },

  async discoverFiles(opts?: ProviderDiscoverOptions) {
    const files = await discoverGeminiSessionFiles(opts?.rootOverride)
    const filter = opts?.projectFilter
    if (!filter || filter.length === 0) return files

    const filterSet = new Set(filter)
    const matched: string[] = []
    for (const f of files) {
      const meta = await readGeminiSessionMeta(f)
      if (meta?.cwd && filterSet.has(encodeProjectPath(normalizePath(meta.cwd)))) matched.push(f)
    }
    return matched
  },

  async readMeta(filePath): Promise<ProviderSessionMeta | null> {
    return readGeminiSessionMeta(filePath)
  },

  parseFile(filePath) {
    return parseGeminiSessionFile(filePath)
  }
}
