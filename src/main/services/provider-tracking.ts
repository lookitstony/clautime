import { settingsService } from './settings-service'
import { PROVIDERS, providerSettingKey } from '../../shared/providers'
import type { SessionTool } from '../../shared/types/session'

/**
 * Whether a provider's sessions should be tracked. Absent setting ⇒ enabled, so
 * every provider defaults on.
 *
 * The "keep at least one provider on" invariant is enforced in the Settings UI,
 * but is also backstopped here: if EVERY provider ends up disabled (a corrupted
 * app_settings row, a direct settings write, or any non-UI caller), treat them
 * all as enabled. Otherwise the next scan's purgeDisabledProviders would delete
 * every auto session for all providers and enabledProviders() would return [],
 * leaving nothing to rediscover.
 */
export function isProviderEnabled(tool: SessionTool): boolean {
  if (settingsService.getSetting(providerSettingKey(tool)) !== 'false') return true
  const anyEnabled = PROVIDERS.some((p) => settingsService.getSetting(p.settingKey) !== 'false')
  return !anyEnabled
}
