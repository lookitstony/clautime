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
  codexProvider,
  geminiProvider,
  opencodeProvider
} from './index'

const CODEX_PATH = 'C:\\Users\\t\\.codex\\sessions\\2026\\07\\19\\rollout-abc.jsonl'
const CLAUDE_PATH = 'C:\\Users\\t\\.claude\\projects\\C--apps-Foo\\session.jsonl'
const GEMINI_PATH =
  'C:\\Users\\t\\.gemini\\tmp\\myproj\\chats\\session-2026-07-19T10-00-abcd1234.json'
const OPENCODE_PATH =
  'C:\\Users\\t\\.local\\share\\opencode\\storage\\session\\global\\ses_abc123.json'

describe('provider registry', () => {
  it('registers claude, codex, gemini, opencode in scan order', () => {
    expect(providerRegistry.map((p) => p.id)).toEqual(['claude', 'codex', 'gemini', 'opencode'])
  })

  it('routes codex rollout paths to the codex provider', () => {
    expect(providerForFile(CODEX_PATH).id).toBe('codex')
  })

  it('routes gemini chat paths to the gemini provider', () => {
    expect(providerForFile(GEMINI_PATH).id).toBe('gemini')
  })

  it('routes opencode storage paths to the opencode provider', () => {
    expect(providerForFile(OPENCODE_PATH).id).toBe('opencode')
  })

  it('routes everything else to claude (default)', () => {
    expect(providerForFile(CLAUDE_PATH).id).toBe('claude')
  })

  it('ownsFile is exclusive per provider', () => {
    const paths = [CLAUDE_PATH, CODEX_PATH, GEMINI_PATH, OPENCODE_PATH]
    const owners = [claudeProvider, codexProvider, geminiProvider, opencodeProvider]
    for (let i = 0; i < paths.length; i++) {
      for (let j = 0; j < owners.length; j++) {
        expect(owners[j].ownsFile(paths[i])).toBe(i === j)
      }
    }
  })

  it('enabledProviders returns every provider when tracking is unset', () => {
    expect(enabledProviders().map((p) => p.id)).toEqual(['claude', 'codex', 'gemini', 'opencode'])
  })
})
