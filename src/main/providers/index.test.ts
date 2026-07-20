// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
}))

// The registry pulls in provider-tracking → settings-service (DB/electron). Stub
// it so an unset setting reads as enabled, matching production defaults.
vi.mock('../services/settings-service', () => ({
  settingsService: { getSetting: vi.fn(() => null) }
}))

import {
  providerForFile,
  providerRegistry,
  enabledProviders,
  claudeProvider,
  codexProvider
} from './index'

const CODEX_PATH = 'C:\\Users\\t\\.codex\\sessions\\2026\\07\\19\\rollout-abc.jsonl'
const CLAUDE_PATH = 'C:\\Users\\t\\.claude\\projects\\C--apps-Foo\\session.jsonl'

describe('provider registry', () => {
  it('registers claude then codex, in scan order', () => {
    expect(providerRegistry.map((p) => p.id)).toEqual(['claude', 'codex'])
  })

  it('routes codex rollout paths to the codex provider', () => {
    expect(providerForFile(CODEX_PATH).id).toBe('codex')
  })

  it('routes everything else to claude (default)', () => {
    expect(providerForFile(CLAUDE_PATH).id).toBe('claude')
  })

  it('ownsFile is exclusive per provider', () => {
    expect(codexProvider.ownsFile(CODEX_PATH)).toBe(true)
    expect(claudeProvider.ownsFile(CODEX_PATH)).toBe(false)
    expect(claudeProvider.ownsFile(CLAUDE_PATH)).toBe(true)
    expect(codexProvider.ownsFile(CLAUDE_PATH)).toBe(false)
  })

  it('enabledProviders returns every provider when tracking is unset', () => {
    expect(enabledProviders().map((p) => p.id)).toEqual(['claude', 'codex'])
  })
})
