import type { SessionTool } from './types/session'

/**
 * Registry of the coding-agent providers ClauTime can track. Adding a new
 * provider is a data change here (plus a parser): the Settings toggles, session
 * badges, and per-provider tracking gate are all driven off this list.
 */
export interface ProviderInfo {
  /** Value stored in sessions.tool. */
  id: SessionTool
  /** Full name, e.g. shown in Settings and the detail panel. */
  label: string
  /** Short name for the compact session-row badge. */
  shortLabel: string
  /** Settings-panel blurb. */
  description: string
  /** app_settings key gating this provider (absent ⇒ enabled). */
  settingKey: string
  /** Tailwind classes for the session-row badge (bg tint + text color). */
  badgeClass: string
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    shortLabel: 'Claude',
    description:
      'Scan Claude Code logs (~/.claude*/projects) and fold them into sessions, hours, and invoicing.',
    settingKey: 'track_claude',
    badgeClass: 'bg-[rgba(217,119,87,0.12)] text-[#d97757]'
  },
  {
    id: 'codex',
    label: 'Codex',
    shortLabel: 'Codex',
    description:
      'Scan OpenAI Codex CLI logs (~/.codex/sessions) and fold them into sessions, hours, and invoicing.',
    settingKey: 'track_codex',
    badgeClass: 'bg-[rgba(74,222,128,0.1)] text-[#4ade80]'
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    shortLabel: 'Gemini',
    description:
      'Scan Gemini CLI chat logs (~/.gemini/tmp) and fold them into sessions, hours, and invoicing.',
    settingKey: 'track_gemini',
    badgeClass: 'bg-[rgba(66,133,244,0.12)] text-[#669df6]'
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    shortLabel: 'OpenCode',
    description:
      'Scan OpenCode session storage (~/.local/share/opencode) and fold it into sessions, hours, and invoicing.',
    settingKey: 'track_opencode',
    badgeClass: 'bg-[rgba(161,161,170,0.12)] text-[#b8b8c0]'
  }
]

/** The app_settings key that gates a provider (absent ⇒ enabled). */
export function providerSettingKey(tool: SessionTool): string {
  return `track_${tool}`
}

/** Look up a provider's display metadata, falling back to Claude. */
export function providerInfo(tool: SessionTool): ProviderInfo {
  return PROVIDERS.find((p) => p.id === tool) ?? PROVIDERS[0]
}
