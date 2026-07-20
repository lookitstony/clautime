import { claudeProvider } from './claude-provider'
import { codexProvider } from './codex-provider'
import { isProviderEnabled } from '../services/provider-tracking'
import type { SessionProvider } from './types'

export type { SessionProvider, ProviderDiscoverOptions, ProviderSessionMeta } from './types'
export { claudeProvider } from './claude-provider'
export { codexProvider } from './codex-provider'

/**
 * Every registered provider, in scan order (Claude first). Adding a coding-agent
 * data source = write a parser + a SessionProvider adapter + one entry here; the
 * scan/backfill/rebuild pipeline picks it up with no further edits.
 */
export const providerRegistry: SessionProvider[] = [claudeProvider, codexProvider]

/** Providers whose per-tool tracking toggle is currently on. */
export function enabledProviders(): SessionProvider[] {
  return providerRegistry.filter((p) => isProviderEnabled(p.id))
}

/** The provider that owns a given file path (falls back to Claude). */
export function providerForFile(filePath: string): SessionProvider {
  return providerRegistry.find((p) => p.ownsFile(filePath)) ?? claudeProvider
}
