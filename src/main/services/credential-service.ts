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
  },

  // ── Stripe API Keys (live + test) ──

  storeEncrypted(settingKey: string, value: string): void {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(value)
      const base64 = encrypted.toString('base64')
      settingsService.setSetting(settingKey, `${ENCRYPTED_KEY_PREFIX}${base64}`)
    } else {
      settingsService.setSetting(settingKey, value)
      log.warn(`safeStorage unavailable — ${settingKey} stored without encryption`)
    }
  },

  getEncrypted(settingKey: string): string | null {
    const stored = settingsService.getSetting(settingKey)
    if (!stored) return null
    if (stored.startsWith(ENCRYPTED_KEY_PREFIX)) {
      try {
        const base64 = stored.slice(ENCRYPTED_KEY_PREFIX.length)
        const buffer = Buffer.from(base64, 'base64')
        return safeStorage.decryptString(buffer)
      } catch (error) {
        log.error(`Failed to decrypt ${settingKey}:`, error)
        return null
      }
    }
    return stored
  },

  /**
   * Store a Stripe secret key securely. Automatically routes to live or test slot.
   */
  storeStripeKey(key: string): void {
    if (key.startsWith('sk_live_')) {
      this.storeEncrypted('stripe_api_key_live', key)
      log.info('Stripe live API key stored')
    } else if (key.startsWith('sk_test_')) {
      this.storeEncrypted('stripe_api_key_test', key)
      log.info('Stripe test API key stored')
    } else {
      throw new Error('Stripe key must start with sk_live_ or sk_test_')
    }
    // Migrate: clear old single-key setting if present
    if (settingsService.getSetting('stripe_api_key')) {
      settingsService.setSetting('stripe_api_key', '')
    }
  },

  /**
   * Get the active Stripe key based on current mode.
   */
  getStripeKey(): string | null {
    const mode = this.getStripeMode()
    const key = this.getEncrypted(mode === 'test' ? 'stripe_api_key_test' : 'stripe_api_key_live')
    if (key) return key
    // Fallback: try old single-key setting for migration
    return this.getEncrypted('stripe_api_key')
  },

  /**
   * Remove the Stripe API key for a specific mode.
   */
  removeStripeKey(mode?: 'live' | 'test'): void {
    const target = mode ?? this.getStripeMode()
    settingsService.setSetting(target === 'test' ? 'stripe_api_key_test' : 'stripe_api_key_live', '')
    log.info(`Stripe ${target} API key removed`)
  },

  /**
   * Check if a Stripe API key is stored for the current mode.
   */
  hasStripeKey(): boolean {
    return !!this.getStripeKey()
  },

  /**
   * Check if a specific mode has a key stored.
   */
  hasStripeKeyForMode(mode: 'live' | 'test'): boolean {
    return !!this.getEncrypted(mode === 'test' ? 'stripe_api_key_test' : 'stripe_api_key_live')
  },

  /**
   * Get the current Stripe mode: 'live' or 'test'.
   */
  getStripeMode(): 'live' | 'test' {
    const mode = settingsService.getSetting('stripe_mode')
    return mode === 'test' ? 'test' : 'live'
  },

  /**
   * Set the Stripe mode.
   */
  setStripeMode(mode: 'live' | 'test'): void {
    settingsService.setSetting('stripe_mode', mode)
    log.info(`Stripe mode set to ${mode}`)
  },

  /**
   * Check if the stored Stripe key is a test mode key.
   */
  isStripeTestMode(): boolean {
    return this.getStripeMode() === 'test'
  },

  /**
   * Get the test email override for sandbox mode.
   */
  getStripeTestEmail(): string | null {
    return settingsService.getSetting('stripe_test_email') || null
  },

  /**
   * Set the test email override for sandbox mode.
   */
  setStripeTestEmail(email: string): void {
    settingsService.setSetting('stripe_test_email', email)
    log.info('Stripe test email updated')
  }
}
