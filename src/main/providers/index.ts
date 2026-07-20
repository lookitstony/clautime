import { claudeProvider } from './claude-provider'
import { codexProvider } from './codex-provider'
import { geminiProvider } from './gemini-provider'
import { opencodeProvider } from './opencode-provider'
import { isProviderEnabled } from '../services/provider-tracking'
import type { SessionProvider } from './types'

export type { SessionProvider, ProviderDiscoverOptions, ProviderSessionMeta } from './types'
export { claudeProvider } from './claude-provider'
export { codexProvider } from './codex-provider'
export { geminiProvider } from './gemini-provider'
export { opencodeProvider } from './opencode-provider'

/**
 * Every registered provider, in scan order (Claude first). Adding a coding-agent
 * data source = write a parser + a SessionProvider adapter + one entry here; the
 * scan/backfill/rebuild pipeline picks it up with no further edits.
 */
export const providerRegistry: SessionProvider[] = [
  claudeProvider,
  codexProvider,
  geminiProvider,
  opencodeProvider
]

/** Providers whose per-tool tracking toggle is currently on. */
export function enabledProviders(): SessionProvider[] {
  return providerRegistry.filter((p) => isProviderEnabled(p.id))
}

/**
 * The provider that owns a given file path. Claude is the catch-all (its
 * ownsFile is true for anything the specific providers don't claim), so give the
 * specific providers first refusal — otherwise a path a specific provider claims
 * via a resolved root (e.g. a custom OPENCODE_DATA_DIR) would be swallowed by
 * Claude, which sits first in the registry.
 */
export function providerForFile(filePath: string): SessionProvider {
  for (const p of providerRegistry) {
    if (p.id !== 'claude' && p.ownsFile(filePath)) return p
  }
  return claudeProvider
}
