import { safeStorage } from 'electron'
import log from 'electron-log/main.js'
import { settingsService } from './settings-service'

const ENCRYPTED_KEY_PREFIX = 'encrypted:'

/**
 * CredentialService handles secure storage of API keys
 * using Electron's safeStorage (OS keychain integration).
 */
export const credentialService = {
  /**
   * Check if safeStorage encryption is available.
   */
  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  },

  /**
   * Store an API key securely.
   * If safeStorage is available, encrypts the key.
   * Falls back to plain storage in settings (not ideal, but functional).
   */
  storeApiKey(key: string): void {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(key)
      const base64 = encrypted.toString('base64')
      settingsService.setSetting('ai_api_key', `${ENCRYPTED_KEY_PREFIX}${base64}`)
      log.info('API key stored securely via safeStorage')
    } else {
      // Fallback: store in settings DB (not encrypted)
      settingsService.setSetting('ai_api_key', key)
      log.warn('safeStorage unavailable — API key stored without encryption')
    }
  },

  /**
   * Retrieve the stored API key.
   * Returns null if no key is stored.
   */
  getApiKey(): string | null {
    const stored = settingsService.getSetting('ai_api_key')
    if (!stored) return null

    if (stored.startsWith(ENCRYPTED_KEY_PREFIX)) {
      try {
        const base64 = stored.slice(ENCRYPTED_KEY_PREFIX.length)
        const buffer = Buffer.from(base64, 'base64')
        return safeStorage.decryptString(buffer)
      } catch (error) {
        log.error('Failed to decrypt API key:', error)
        return null
      }
    }

    // Plain text fallback
    return stored
  },

  /**
   * Remove the stored API key.
   */
  removeApiKey(): void {
    settingsService.setSetting('ai_api_key', '')
    log.info('API key removed')
  },

  /**
   * Check if an API key is stored.
   */
  hasApiKey(): boolean {
    const stored = settingsService.getSetting('ai_api_key')
    return !!stored
  },

  /**
   * Get the configured AI method: 'api-key', 'git-only', or 'claude-login'.
   */
  getAiMethod(): string {
    return settingsService.getSetting('ai_method') ?? 'git-only'
  },

  /**
   * Set the AI method.
   */
  setAiMethod(method: string): void {
    settingsService.setSetting('ai_method', method)
  }
}
