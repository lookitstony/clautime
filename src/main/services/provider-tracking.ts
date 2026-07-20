import { settingsService } from './settings-service'
import { providerSettingKey } from '../../shared/providers'
import type { SessionTool } from '../../shared/types/session'

/**
 * Whether a provider's sessions should be tracked. Absent setting ⇒ enabled, so
 * every provider defaults on. The "keep at least one on" invariant is enforced
 * in the Settings UI, not here — the backend just honors whatever is set.
 */
export function isProviderEnabled(tool: SessionTool): boolean {
  return settingsService.getSetting(providerSettingKey(tool)) !== 'false'
}
