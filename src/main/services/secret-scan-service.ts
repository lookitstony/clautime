import { readFileSync } from 'node:fs'
import { readFile, writeFile, stat, readdir, rename, lstat, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { eq, desc, sql, and } from 'drizzle-orm'
import { Notification } from 'electron'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { secretFindings, secretScanState } from '../db/schema/secret-findings'
import { settingsService } from './settings-service'
import { codexProvider } from '../providers/codex-provider'
import { isProviderEnabled } from './provider-tracking'
import type {
  SecretScanResult,
  SecretFinding,
  SecretScanSummary,
  SecretScanMode,
  CustomSecretPattern,
  PatternTestResult
} from '../../shared/types/secret-scan'

/** Pattern definition — regexes stored WITHOUT /g flag to avoid shared mutable state (F02) */
interface PatternDef {
  id: string
  label: string
  source: string
  flags: string
  severity: 'critical' | 'high' | 'medium'
  redactLabel: string
}

const PATTERN_DEFS: PatternDef[] = [
  // === LLM / AI providers ===
  {
    id: 'anthropic-api-key',
    label: 'Anthropic API Key',
    source: 'sk-ant-[a-zA-Z0-9\\-_]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-anthropic-api-key'
  },
  {
    id: 'openai-api-key',
    label: 'OpenAI API Key',
    source: 'sk-proj-[a-zA-Z0-9\\-_]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-openai-api-key'
  },
  {
    id: 'google-api-key',
    label: 'Google/Gemini API Key',
    source: 'AIzaSy[a-zA-Z0-9\\-_]{30,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-google-api-key'
  },
  {
    id: 'huggingface-token',
    label: 'HuggingFace Token',
    source: 'hf_[a-zA-Z0-9]{30,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-huggingface-token'
  },

  // === Cloud providers ===
  {
    id: 'aws-access-key',
    label: 'AWS Access Key',
    source: 'AKIA[0-9A-Z]{16}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-aws-access-key'
  },

  // === Cloud providers (continued) ===
  {
    id: 'aws-secret-key',
    label: 'AWS Secret Access Key',
    source:
      '(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\\s*[:=]\\s*["\']?[a-zA-Z0-9/+]{40}["\']?',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-aws-secret-key'
  },
  {
    id: 'azure-devops-pat',
    label: 'Azure DevOps PAT',
    source: '[a-z0-9]{52}AZDO[a-z0-9]{24}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-azure-devops-pat'
  },
  {
    id: 'azure-client-secret',
    label: 'Azure Client Secret',
    source: '(?:client_secret|AZURE_CLIENT_SECRET)\\s*[:=]\\s*["\']?[a-zA-Z0-9~_.\\-]{34,}["\']?',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-azure-client-secret'
  },
  {
    id: 'azure-storage-key',
    label: 'Azure Storage Key',
    source: 'DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]+',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-azure-storage-key'
  },
  {
    id: 'gcp-service-account',
    label: 'GCP Service Account Key',
    source: '"type"\\s*:\\s*"service_account"',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-gcp-service-account'
  },

  // === Code hosting / CI ===
  {
    id: 'github-pat',
    label: 'GitHub PAT',
    source: 'ghp_[a-zA-Z0-9]{36}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-github-pat'
  },
  {
    id: 'github-oauth',
    label: 'GitHub OAuth Token',
    source: 'gho_[a-zA-Z0-9]{36}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-github-oauth'
  },
  {
    id: 'github-app-token',
    label: 'GitHub App Token',
    source: 'ghu_[a-zA-Z0-9]{36}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-github-app-token'
  },
  {
    id: 'github-fine-grained',
    label: 'GitHub Fine-Grained PAT',
    source: 'github_pat_[a-zA-Z0-9_]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-github-fine-grained'
  },
  {
    id: 'gitlab-pat',
    label: 'GitLab PAT',
    source: 'glpat-[a-zA-Z0-9\\-_]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-gitlab-pat'
  },
  {
    id: 'bitbucket-app-password',
    label: 'Bitbucket App Password',
    source: 'ATBB[a-zA-Z0-9]{32,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-bitbucket-app-password'
  },

  // === Payment / SaaS ===
  {
    id: 'stripe-secret-key',
    label: 'Stripe Secret Key',
    source: 'sk_(?:live|test)_[a-zA-Z0-9]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-stripe-secret-key'
  },
  {
    id: 'stripe-restricted-key',
    label: 'Stripe Restricted Key',
    source: 'rk_(?:live|test)_[a-zA-Z0-9]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-stripe-restricted-key'
  },
  {
    id: 'twilio-api-key',
    label: 'Twilio API Key',
    source: 'SK[a-f0-9]{32}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-twilio-api-key'
  },
  {
    id: 'sendgrid-api-key',
    label: 'SendGrid API Key',
    source: 'SG\\.[a-zA-Z0-9\\-_]{20,}\\.[a-zA-Z0-9\\-_]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-sendgrid-api-key'
  },
  {
    id: 'mailgun-api-key',
    label: 'Mailgun API Key',
    source: 'key-[a-f0-9]{32}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-mailgun-api-key'
  },
  {
    id: 'brevo-api-key',
    label: 'Brevo (Sendinblue) API Key',
    source: 'xkeysib-[a-f0-9]{64}-[a-zA-Z0-9]{16}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-brevo-api-key'
  },
  {
    id: 'resend-api-key',
    label: 'Resend API Key',
    source: 're_[a-zA-Z0-9]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-resend-api-key'
  },

  // === BaaS / Database ===
  {
    id: 'supabase-key',
    label: 'Supabase Key',
    source: 'sbp_[a-f0-9]{40}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-supabase-key'
  },
  {
    id: 'firebase-key',
    label: 'Firebase Key',
    source: 'AAAA[a-zA-Z0-9_\\-]{7}:[a-zA-Z0-9_\\-]{140,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-firebase-key'
  },
  {
    id: 'planetscale-token',
    label: 'PlanetScale Token',
    source: 'pscale_tkn_[a-zA-Z0-9\\-_]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-planetscale-token'
  },
  {
    id: 'planetscale-password',
    label: 'PlanetScale Password',
    source: 'pscale_pw_[a-zA-Z0-9\\-_]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-planetscale-password'
  },

  // === Communication / Collaboration ===
  {
    id: 'slack-token',
    label: 'Slack Token',
    source: 'xox[bpas]-[a-zA-Z0-9\\-]{10,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-slack-token'
  },
  {
    id: 'slack-webhook',
    label: 'Slack Webhook',
    source: 'https?:\\/\\/hooks\\.slack\\.com\\/[^\\s"\']+',
    flags: '',
    severity: 'high',
    redactLabel: 'REDACTED-slack-webhook'
  },
  {
    id: 'discord-bot-token',
    label: 'Discord Bot Token',
    source: '[MN][a-zA-Z0-9\\-_]{23,}\\.[a-zA-Z0-9\\-_]{6}\\.[a-zA-Z0-9\\-_]{27,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-discord-bot-token'
  },
  {
    id: 'telegram-bot-token',
    label: 'Telegram Bot Token',
    source: '[0-9]{8,10}:[a-zA-Z0-9_\\-]{35}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-telegram-bot-token'
  },

  // === Hosting / CDN / Monitoring ===
  {
    id: 'netlify-token',
    label: 'Netlify Token',
    source: 'nfp_[a-zA-Z0-9]{40,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-netlify-token'
  },
  {
    id: 'datadog-api-key',
    label: 'Datadog API Key',
    source: 'dd[a-z][a-f0-9]{38}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-datadog-api-key'
  },
  {
    id: 'sentry-dsn',
    label: 'Sentry DSN',
    source: 'https?:\\/\\/[a-f0-9]{32}@[a-z0-9.]+\\.ingest\\.sentry\\.io\\/[0-9]+',
    flags: '',
    severity: 'high',
    redactLabel: 'REDACTED-sentry-dsn'
  },
  {
    id: 'newrelic-key',
    label: 'New Relic Key',
    source: 'NRAK-[a-zA-Z0-9]{27}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-newrelic-key'
  },
  {
    id: 'linear-api-key',
    label: 'Linear API Key',
    source: 'lin_api_[a-zA-Z0-9]{40,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-linear-api-key'
  },
  {
    id: 'doppler-token',
    label: 'Doppler Token',
    source: 'dp\\.(?:ct|pt|st|sa|scim|audit)\\.[a-zA-Z0-9_\\-]{2,35}\\.[a-zA-Z0-9]{40,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-doppler-token'
  },
  {
    id: 'digitalocean-token',
    label: 'DigitalOcean Token',
    source: 'do[por]_v1_[0-9a-f]{64}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-digitalocean-token'
  },
  {
    id: 'vault-token',
    label: 'HashiCorp Vault Token',
    source: 'hv[sbr]\\.[a-zA-Z0-9]{24,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-vault-token'
  },
  {
    id: 'fly-token',
    label: 'Fly.io Token',
    source: 'fm2_[a-zA-Z0-9+/=_\\-]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-fly-token'
  },

  // === MCP / Tool Tokens ===
  {
    id: 'mcp-token',
    label: 'MCP Tool Token',
    source: 'mcp_[a-zA-Z0-9_]{10,}\\.[a-zA-Z0-9_\\-]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-mcp-token'
  },

  // === Productivity / No-Code ===
  {
    id: 'airtable-pat',
    label: 'Airtable Personal Access Token',
    source: 'pat[a-zA-Z0-9]{14}\\.[a-f0-9]{64}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-airtable-pat'
  },

  // === Communications / VoIP ===
  {
    id: 'vonage-api-key',
    label: 'Vonage/Nexmo API Key',
    source: 'vck_[a-zA-Z0-9]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-vonage-api-key'
  },

  // === E-commerce / Platform ===
  {
    id: 'shopify-token',
    label: 'Shopify Token',
    source: 'shp(?:at|ca|pa|ss|ua)_[a-fA-F0-9]{32,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-shopify-token'
  },
  {
    id: 'replicate-token',
    label: 'Replicate Token',
    source: 'r8_[a-zA-Z0-9]{37}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-replicate-token'
  },
  {
    id: 'groq-api-key',
    label: 'Groq API Key',
    source: 'gsk_[a-zA-Z0-9]{48,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-groq-api-key'
  },
  {
    id: 'railway-token',
    label: 'Railway Token',
    source: 'railway_[a-zA-Z0-9_\\-]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-railway-token'
  },
  {
    id: 'render-api-key',
    label: 'Render API Key',
    source: 'rnd_[a-zA-Z0-9]{20,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-render-api-key'
  },
  {
    id: 'pinecone-api-key',
    label: 'Pinecone API Key',
    source: 'pcsk_[a-zA-Z0-9_]{40,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-pinecone-api-key'
  },

  // === Auth / Identity ===
  {
    id: 'okta-token',
    label: 'Okta API Token',
    source: '00[a-zA-Z0-9_-]{40}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-okta-token'
  },
  {
    id: 'auth0-client-secret',
    label: 'Auth0 Client Secret',
    source:
      '(?:auth0_client_secret|AUTH0_CLIENT_SECRET)\\s*[:=]\\s*["\']?[a-zA-Z0-9_\\-]{32,}["\']?',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-auth0-client-secret'
  },
  {
    id: 'vercel-token',
    label: 'Vercel Token',
    source: 'vercel_[a-zA-Z0-9_\\-]{24,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-vercel-token'
  },
  {
    id: 'cloudflare-api-token',
    label: 'Cloudflare API Token',
    source: 'cf_[a-zA-Z0-9_\\-]{37,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-cloudflare-api-token'
  },

  // === Crypto / Keys / Generic ===
  {
    id: 'private-key',
    label: 'Private Key',
    source: '-----BEGIN\\s+(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-private-key'
  },
  {
    id: 'jwt-token',
    label: 'JWT Token',
    source: 'eyJ[a-zA-Z0-9_\\-]{20,}\\.[a-zA-Z0-9_\\-]{20,}\\.[a-zA-Z0-9_\\-]{20,}',
    flags: '',
    severity: 'high',
    redactLabel: 'REDACTED-jwt-token'
  },
  {
    id: 'connection-string',
    label: 'Connection String',
    source: '(?:mongodb\\+srv?|postgres(?:ql)?|mysql|redis|amqp):\\/\\/[^\\s"\'`]+',
    flags: '',
    severity: 'high',
    redactLabel: 'REDACTED-connection-string'
  },
  {
    id: 'bearer-token',
    label: 'Bearer Token',
    source: 'Bearer\\s+[a-zA-Z0-9\\-_.~+/]{20,}',
    flags: '',
    severity: 'high',
    redactLabel: 'REDACTED-bearer-token'
  },
  {
    id: 'npm-token',
    label: 'NPM Token',
    source: 'npm_[a-zA-Z0-9]{36}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-npm-token'
  },
  {
    id: 'pypi-token',
    label: 'PyPI Token',
    source: 'pypi-[a-zA-Z0-9\\-_]{50,}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-pypi-token'
  },
  {
    id: 'nuget-api-key',
    label: 'NuGet API Key',
    source: 'oy2[a-z0-9]{43}',
    flags: '',
    severity: 'critical',
    redactLabel: 'REDACTED-nuget-api-key'
  },
  {
    id: 'generic-api-key',
    label: 'Generic API Key/Secret',
    source:
      '(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key)\\s*[:=]\\s*["\']?[a-zA-Z0-9\\-_.]{16,}["\']?',
    flags: 'i',
    severity: 'medium',
    redactLabel: 'REDACTED-api-key'
  },
  {
    id: 'env-secret-assignment',
    label: 'Env/Config Secret',
    source:
      '[A-Z_]*(?:SECRET|PRIVATE|TOKEN|APIKEY|API_KEY|CREDENTIALS|AUTH)[A-Z_]*\\s*[:=]\\s*["\']?[a-zA-Z0-9\\-_.+/]{16,}["\']?',
    flags: '',
    severity: 'medium',
    redactLabel: 'REDACTED-env-secret'
  },
  {
    id: 'password-assignment',
    label: 'Password Assignment',
    source: '(?:password|passwd|pwd)\\s*[:=]\\s*["\']?[^\\s"\']{8,}["\']?',
    flags: 'i',
    severity: 'medium',
    redactLabel: 'REDACTED-password'
  },

  // === JSON/Config format secrets (handles "Key": "value" with optional backslash-escaping in JSONL) ===
  {
    id: 'json-config-secret-key',
    label: 'JSON/Config Secret Key',
    source:
      '(?:ApiKey|ClientSecret|SecretKey|AccessToken|AuthToken|ApiSecret)(?:[\\\\]*")?\\s*:\\s*(?:[\\\\]*")?\\s*[a-zA-Z0-9\\-_.+/~@{}|]{16,}',
    flags: 'i',
    severity: 'high',
    redactLabel: 'REDACTED-config-secret'
  },
  {
    id: 'json-config-password',
    label: 'JSON/Config Password',
    source: '(?:password|passwd|pwd)(?:[\\\\]*")?\\s*:\\s*(?:[\\\\]*")?\\s*[^\\\\s"\\\\\\\\]{8,}',
    flags: 'i',
    severity: 'high',
    redactLabel: 'REDACTED-config-password'
  }
]

/** Create a fresh global regex from a pattern def — safe for single-use iteration (F02) */
function makeGlobalRegex(p: PatternDef): RegExp {
  return new RegExp(p.source, p.flags + 'g')
}

/** Safe preview — length hint only, no actual secret content */
function redactedPreview(secret: string): string {
  return `${secret.length} chars`
}

/** No surrounding text stored — prevents leaking adjacent secrets */
function extractContext(): string {
  return ''
}

/** Get today's midnight as a Date for file filtering */
function getTodayMidnight(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/** Discover JSONL files in claude projects directory, including subagent files */
async function discoverJsonlFiles(claudeDir: string): Promise<string[]> {
  const projectsDir = join(claudeDir, 'projects')
  const files: string[] = []

  let projectDirs: import('node:fs').Dirent<string>[]
  try {
    projectDirs = await readdir(projectsDir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    log.warn(`secret-scan: Failed to read projects directory: ${projectsDir}`)
    return files
  }

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue
    // Skip symlinks at project level (F10)
    try {
      const dirStat = await lstat(join(projectsDir, dir.name))
      if (dirStat.isSymbolicLink()) continue
    } catch {
      continue
    }

    const projectPath = join(projectsDir, dir.name)
    try {
      const entries = await readdir(projectPath, { withFileTypes: true, encoding: 'utf8' })
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(join(projectPath, entry.name))
        }
        if (entry.isDirectory()) {
          try {
            const subDir = join(projectPath, entry.name)
            const subEntries = await readdir(subDir, { withFileTypes: true, encoding: 'utf8' })
            for (const sub of subEntries) {
              if (sub.isFile() && sub.name.endsWith('.jsonl')) {
                files.push(join(subDir, sub.name))
              }
              if (sub.isDirectory() && sub.name === 'subagents') {
                try {
                  const saEntries = await readdir(join(subDir, 'subagents'), {
                    withFileTypes: true,
                    encoding: 'utf8'
                  })
                  for (const sa of saEntries) {
                    if (sa.isFile() && sa.name.endsWith('.jsonl')) {
                      files.push(join(subDir, 'subagents', sa.name))
                    }
                  }
                } catch {
                  /* ignore */
                }
              }
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      log.warn(`secret-scan: Failed to read project directory: ${projectPath}`, err)
    }
  }

  return files
}

/** Check if a regex pattern is dangerously broad */
function validatePatternBroadness(source: string, flags: string): string[] {
  const warnings: string[] = []

  // Check for overly short patterns
  if (source.length < 6) {
    warnings.push('Pattern is very short — may match too broadly.')
  }

  // Check for catch-all quantifiers without anchoring
  const broadPatterns = [
    { re: /^\.\*/, msg: 'Starts with .* — will match almost anything.' },
    { re: /^\.\+/, msg: 'Starts with .+ — will match almost anything.' },
    { re: /^\\w\+$/, msg: 'Pattern is just \\w+ — matches any word.' },
    { re: /^\\d\+$/, msg: 'Pattern is just \\d+ — matches any number.' },
    { re: /^\[a-z/, msg: 'Starts with a broad character class — consider adding a prefix anchor.' },
    { re: /^\[A-Z/, msg: 'Starts with a broad character class — consider adding a prefix anchor.' },
    {
      re: /^\[a-zA-Z/,
      msg: 'Starts with a broad character class — consider adding a prefix anchor.'
    }
  ]

  for (const { re, msg } of broadPatterns) {
    if (re.test(source)) {
      warnings.push(msg)
      break // one broadness warning is enough
    }
  }

  // Check if case-insensitive on an already broad pattern
  if (flags.includes('i') && source.length < 10) {
    warnings.push('Case-insensitive flag on a short pattern increases false positives.')
  }

  // Test against common English words to detect over-matching
  const commonWords =
    'the quick brown fox jumps over the lazy dog hello world function return const var let import export class interface type true false null undefined'
  try {
    const regex = new RegExp(source, flags + 'g')
    const testMatches = commonWords.match(regex)
    if (testMatches && testMatches.length > 3) {
      warnings.push(
        `Pattern matches ${testMatches.length} common English words — very likely too broad.`
      )
    }
  } catch {
    // Invalid regex — will be caught separately
  }

  return warnings
}

export const secretScanService = {
  _scanInterval: null as ReturnType<typeof setInterval> | null,
  _isScanning: false,
  _isRedacting: false, // F06: guard against concurrent redaction
  _activeScanPromise: null as Promise<SecretScanResult> | null,

  /** Start hourly scanning: scan 30s after startup, then every hour */
  startDailyScanning(): void {
    log.info('secret-scan: Starting hourly scanning')

    // Initial scan 30s after startup
    setTimeout(() => {
      this.runScan().catch((err: unknown) => {
        log.error('secret-scan: Auto scan failed:', err)
      })
    }, 30000)

    // Repeat every hour
    this._scanInterval = setInterval(() => {
      log.info('secret-scan: Hourly scan triggered')
      this.runScan().catch((err: unknown) => {
        log.error('secret-scan: Hourly scan failed:', err)
      })
    }, 3600000)
  },

  /** Stop hourly scanning */
  stopDailyScanning(): void {
    if (this._scanInterval) {
      clearInterval(this._scanInterval)
      this._scanInterval = null
    }
    log.info('secret-scan: Stopped daily scanning')
  },

  /** Main scan logic — if a scan is already running, returns the active scan's promise */
  runScan(): Promise<SecretScanResult> {
    if (this._isScanning && this._activeScanPromise) {
      log.info('secret-scan: Scan already in progress, waiting for it to finish')
      return this._activeScanPromise
    }

    this._isScanning = true
    this._activeScanPromise = this._runScanInner().finally(() => {
      this._isScanning = false
      this._activeScanPromise = null
    })
    return this._activeScanPromise
  },

  /** Internal scan implementation */
  async _runScanInner(): Promise<SecretScanResult> {
    const result: SecretScanResult = {
      filesScanned: 0,
      filesSkipped: 0,
      newFindings: 0,
      redacted: 0,
      errors: 0
    }

    const claudeDir = settingsService.getSetting('claude_dir') || join(homedir(), '.claude')
    const todayMidnight = getTodayMidnight()

    // Scan each provider's transcripts unless its tracking is off. Codex rollouts
    // hold the same kind of text as Claude JSONL — scanning and redaction are
    // line-based and format-agnostic, so no provider-specific handling is needed.
    const allFiles = isProviderEnabled('claude') ? await discoverJsonlFiles(claudeDir) : []
    if (isProviderEnabled('codex')) {
      const codexFiles = await codexProvider.discoverFiles()
      allFiles.push(...codexFiles)
      log.info(`secret-scan: Including ${codexFiles.length} Codex JSONL files`)
    }
    log.info(`secret-scan: Discovered ${allFiles.length} JSONL files`)

    // Filter: only files with mtime before today's midnight
    const eligibleFiles: Array<{ path: string; mtime: Date; size: number }> = []
    for (const filePath of allFiles) {
      if (!this._isScanning) break
      try {
        const fileStat = await stat(filePath)
        if (fileStat.mtime < todayMidnight) {
          eligibleFiles.push({ path: filePath, mtime: fileStat.mtime, size: fileStat.size })
        }
      } catch {
        /* file may have been deleted */
      }
    }

    log.info(`secret-scan: ${eligibleFiles.length} files eligible (before today)`)

    const db = getDb()
    for (const file of eligibleFiles) {
      if (!this._isScanning) break

      const existing = db
        .select()
        .from(secretScanState)
        .where(eq(secretScanState.filePath, file.path))
        .get()

      if (
        existing &&
        existing.lastModifiedAt === file.mtime.toISOString() &&
        existing.lastFileSize === file.size
      ) {
        result.filesSkipped++
        continue
      }

      try {
        // F01/F09: Delete stale findings for this file before re-scanning
        db.delete(secretFindings).where(eq(secretFindings.sourceFile, file.path)).run()

        const findings = await this.scanFile(file.path)
        result.filesScanned++
        result.newFindings += findings

        db.insert(secretScanState)
          .values({
            filePath: file.path,
            lastModifiedAt: file.mtime.toISOString(),
            lastScannedAt: new Date().toISOString(),
            lastFileSize: file.size,
            findingCount: findings
          })
          .onConflictDoUpdate({
            target: secretScanState.filePath,
            set: {
              lastModifiedAt: file.mtime.toISOString(),
              lastScannedAt: new Date().toISOString(),
              lastFileSize: file.size,
              findingCount: findings
            }
          })
          .run()
      } catch (err) {
        log.error(`secret-scan: Error scanning file ${file.path}:`, err)
        result.errors++
      }
    }

    // Get scan mode
    const mode = (settingsService.getSetting('secret_scan_mode') || 'monitor') as SecretScanMode

    if (mode === 'auto-clean' && result.newFindings > 0) {
      const redactedCount = await this.redactFindings()
      result.redacted = redactedCount
    }

    if (mode === 'monitor-alert' && result.newFindings > 0) {
      try {
        new Notification({
          title: 'ClauTime — Secrets Detected',
          body: `Found ${result.newFindings} potential secret${result.newFindings === 1 ? '' : 's'} in JSONL files.`,
          silent: false
        }).show()
      } catch (err) {
        log.warn('secret-scan: Failed to show notification:', err)
      }
    }

    // F18: Update last scan date in finally-safe position
    settingsService.setSetting('secret_scan_last_date', new Date().toISOString().slice(0, 10))

    log.info(
      `secret-scan: Scan complete — ${result.filesScanned} scanned, ${result.filesSkipped} skipped, ${result.newFindings} findings, ${result.redacted} redacted, ${result.errors} errors`
    )

    return result
  },

  /** Scan a single file for secrets — works independently of _isScanning (F07) */
  async scanFile(filePath: string): Promise<number> {
    const content = await readFile(filePath, 'utf-8')
    const lines = content.split('\n')
    const db = getDb()
    let findingCount = 0

    // Merge built-in + enabled custom patterns
    const customPatterns = this.getCustomPatterns()
      .filter((p) => p.enabled)
      .map(
        (p): PatternDef => ({
          id: `custom:${p.id}`,
          label: p.label,
          source: p.source,
          flags: p.flags,
          severity: p.severity,
          redactLabel: p.redactLabel
        })
      )
    const allPatterns = [...PATTERN_DEFS, ...customPatterns]

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue

      for (const patternDef of allPatterns) {
        // F02: Create fresh regex per pattern per line — no shared mutable state
        const regex = makeGlobalRegex(patternDef)
        let match: RegExpExecArray | null

        while ((match = regex.exec(line)) !== null) {
          const secret = match[0]
          const preview = redactedPreview(secret)
          const context = extractContext()

          db.insert(secretFindings)
            .values({
              sourceFile: filePath,
              lineNumber: i + 1,
              secretType: patternDef.id,
              redactedPreview: preview,
              severity: patternDef.severity,
              context,
              scannedAt: new Date().toISOString(),
              status: 'found'
            })
            .run()

          findingCount++
        }
      }
    }

    return findingCount
  },

  /** Redact all unredacted findings in-place using atomic file operations (F03: line-targeted) */
  async redactFindings(): Promise<number> {
    if (this._isRedacting) {
      log.warn('secret-scan: Redaction already in progress, skipping')
      return 0
    }
    this._isRedacting = true

    try {
      const db = getDb()
      const unredacted = db
        .select()
        .from(secretFindings)
        .where(eq(secretFindings.status, 'found'))
        .all()

      if (unredacted.length === 0) return 0

      // Group findings by source file
      const byFile = new Map<string, typeof unredacted>()
      for (const finding of unredacted) {
        const existing = byFile.get(finding.sourceFile) || []
        existing.push(finding)
        byFile.set(finding.sourceFile, existing)
      }

      let totalRedacted = 0

      for (const [filePath, findings] of byFile) {
        try {
          const content = await readFile(filePath, 'utf-8')
          const lines = content.split('\n')

          // F03: Build set of lines that have findings, keyed by line number
          const findingsByLine = new Map<number, typeof findings>()
          for (const f of findings) {
            const existing = findingsByLine.get(f.lineNumber) || []
            existing.push(f)
            findingsByLine.set(f.lineNumber, existing)
          }

          // Only modify lines that have findings
          for (const [lineNum, lineFindings] of findingsByLine) {
            const lineIdx = lineNum - 1
            if (lineIdx >= lines.length) continue

            let line = lines[lineIdx]
            // Get unique pattern types on this line
            const patternIds = new Set(lineFindings.map((f) => f.secretType))
            for (const patternId of patternIds) {
              const patternDef = PATTERN_DEFS.find((p) => p.id === patternId)
              if (!patternDef) continue
              const regex = makeGlobalRegex(patternDef)
              line = line.replace(regex, `[${patternDef.redactLabel}]`)
            }
            lines[lineIdx] = line
          }

          // Atomic write
          const tmpPath = `${filePath}.tmp`
          await writeFile(tmpPath, lines.join('\n'), 'utf-8')
          await rename(tmpPath, filePath)

          // Update all findings for this file
          const now = new Date().toISOString()
          for (const finding of findings) {
            db.update(secretFindings)
              .set({ status: 'redacted', redactedAt: now })
              .where(eq(secretFindings.id, finding.id))
              .run()
          }

          // Update scan state with new file stats
          const newStat = await stat(filePath)
          db.update(secretScanState)
            .set({
              lastModifiedAt: newStat.mtime.toISOString(),
              lastFileSize: newStat.size,
              lastScannedAt: now
            })
            .where(eq(secretScanState.filePath, filePath))
            .run()

          totalRedacted += findings.length
        } catch (err) {
          log.error(`secret-scan: Failed to redact file ${filePath}:`, err)
        }
      }

      // Collapse redacted findings: dedupe by (sourceFile, secretType) into single rows with summed occurrences
      this._collapseRedactedFindings()

      log.info(`secret-scan: Redacted ${totalRedacted} findings across ${byFile.size} files`)
      return totalRedacted
    } finally {
      this._isRedacting = false
    }
  },

  /** Collapse all redacted findings into deduplicated rows grouped by secretType only */
  _collapseRedactedFindings(): void {
    const db = getDb()

    const groups = db
      .select({
        secretType: secretFindings.secretType,
        severity: secretFindings.severity,
        totalOccurrences: sql<number>`sum(${secretFindings.occurrences})`,
        count: sql<number>`count(*)`,
        latestRedactedAt: sql<string>`max(${secretFindings.redactedAt})`,
        latestScannedAt: sql<string>`max(${secretFindings.scannedAt})`,
        keepId: sql<number>`min(${secretFindings.id})`
      })
      .from(secretFindings)
      .where(eq(secretFindings.status, 'redacted'))
      .groupBy(secretFindings.secretType)
      .all()

    let collapsed = 0
    for (const group of groups) {
      if (group.count <= 1) continue

      db.update(secretFindings)
        .set({
          occurrences: group.totalOccurrences,
          redactedAt: group.latestRedactedAt,
          scannedAt: group.latestScannedAt,
          redactedPreview: `${group.totalOccurrences} redacted`,
          context: '',
          sourceFile: '',
          lineNumber: 0
        })
        .where(eq(secretFindings.id, group.keepId))
        .run()

      // Delete all other redacted rows of this type
      db.run(sql`
        DELETE FROM secret_findings
        WHERE secret_type = ${group.secretType}
          AND status = 'redacted'
          AND id != ${group.keepId}
      `)

      collapsed += group.count - 1
    }

    if (collapsed > 0) {
      log.info(`secret-scan: Collapsed ${collapsed} redundant redacted findings`)
    }
  },

  /** Get findings with pagination (F05: validated limits) */
  getFindings(limit = 100, offset = 0): SecretFinding[] {
    const safeLimit = Math.max(1, Math.min(limit, 500))
    const safeOffset = Math.max(0, offset)
    const db = getDb()
    return db
      .select()
      .from(secretFindings)
      .orderBy(desc(secretFindings.scannedAt))
      .limit(safeLimit)
      .offset(safeOffset)
      .all() as SecretFinding[]
  },

  /** Get summary counts (uses occurrences for accurate totals after dedup) */
  getFindingsSummary(): SecretScanSummary {
    const db = getDb()
    const rows = db
      .select({
        status: secretFindings.status,
        severity: secretFindings.severity,
        count: sql<number>`sum(${secretFindings.occurrences})`
      })
      .from(secretFindings)
      .groupBy(secretFindings.status, secretFindings.severity)
      .all()

    const summary: SecretScanSummary = {
      total: 0,
      found: 0,
      redacted: 0,
      ignored: 0,
      bySeverity: { critical: 0, high: 0, medium: 0 }
    }

    for (const row of rows) {
      summary.total += row.count
      if (row.status === 'found') summary.found += row.count
      if (row.status === 'redacted') summary.redacted += row.count
      if (row.status === 'ignored') summary.ignored += row.count
      if (row.severity === 'critical') summary.bySeverity.critical += row.count
      if (row.severity === 'high') summary.bySeverity.high += row.count
      if (row.severity === 'medium') summary.bySeverity.medium += row.count
    }

    return summary
  },

  /** Mark a finding as ignored (F05: validated id) */
  ignoreFinding(id: number): void {
    if (!Number.isFinite(id) || id < 1) return
    const db = getDb()
    db.update(secretFindings).set({ status: 'ignored' }).where(eq(secretFindings.id, id)).run()
  },

  /** Redact a single finding in-place (F04: updates all same-type findings on same line) */
  async redactFinding(id: number): Promise<void> {
    if (!Number.isFinite(id) || id < 1) return
    if (this._isRedacting) {
      log.warn('secret-scan: Redaction already in progress')
      return
    }
    this._isRedacting = true

    try {
      const db = getDb()
      const finding = db.select().from(secretFindings).where(eq(secretFindings.id, id)).get()

      if (!finding || finding.status !== 'found') return

      const patternDef = PATTERN_DEFS.find((p) => p.id === finding.secretType)
      if (!patternDef) return

      const content = await readFile(finding.sourceFile, 'utf-8')
      const lines = content.split('\n')

      if (finding.lineNumber - 1 < lines.length) {
        const regex = makeGlobalRegex(patternDef)
        lines[finding.lineNumber - 1] = lines[finding.lineNumber - 1].replace(
          regex,
          `[${patternDef.redactLabel}]`
        )
      }

      const tmpPath = `${finding.sourceFile}.tmp`
      await writeFile(tmpPath, lines.join('\n'), 'utf-8')
      await rename(tmpPath, finding.sourceFile)

      const now = new Date().toISOString()

      // F04: Also mark any other same-type findings on the same line as redacted
      const sameLine = db
        .select()
        .from(secretFindings)
        .where(
          and(
            eq(secretFindings.sourceFile, finding.sourceFile),
            eq(secretFindings.lineNumber, finding.lineNumber),
            eq(secretFindings.secretType, finding.secretType),
            eq(secretFindings.status, 'found')
          )
        )
        .all()

      for (const f of sameLine) {
        db.update(secretFindings)
          .set({ status: 'redacted', redactedAt: now })
          .where(eq(secretFindings.id, f.id))
          .run()
      }

      // Update scan state
      const newStat = await stat(finding.sourceFile)
      db.update(secretScanState)
        .set({
          lastModifiedAt: newStat.mtime.toISOString(),
          lastFileSize: newStat.size,
          lastScannedAt: now
        })
        .where(eq(secretScanState.filePath, finding.sourceFile))
        .run()

      // Collapse after single redaction too
      this._collapseRedactedFindings()
    } catch (err) {
      log.error(`secret-scan: Failed to redact finding ${id}:`, err)
      throw err
    } finally {
      this._isRedacting = false
    }
  },

  /** Cancel an in-progress scan */
  cancel(): void {
    this._isScanning = false
    log.info('secret-scan: Scan cancelled')
  },

  // ============= Custom Patterns (file-based) =============

  /** Resolve path to custom patterns JSON file */
  _getCustomPatternsPath(): string {
    const claudeDir = settingsService.getSetting('claude_dir') || join(homedir(), '.claude')
    return join(claudeDir, 'custom-secret-patterns.json')
  },

  /** Load user-defined custom patterns from JSON file (migrates from settings DB on first call) */
  getCustomPatterns(): CustomSecretPattern[] {
    const filePath = this._getCustomPatternsPath()
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch (err: unknown) {
      // ENOENT — check if there are legacy patterns in the settings DB to migrate
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'ENOENT'
      ) {
        const legacy = settingsService.getSetting('custom_secret_patterns')
        if (legacy) {
          try {
            const parsed = JSON.parse(legacy)
            if (Array.isArray(parsed) && parsed.length > 0) {
              log.info(
                `secret-scan: Migrating ${parsed.length} custom patterns from settings DB to ${filePath}`
              )
              this.saveCustomPatterns(parsed).catch(() => {})
              settingsService.setSetting('custom_secret_patterns', '')
              return parsed
            }
          } catch {
            /* ignore bad legacy data */
          }
        }
        return []
      }
      log.warn(`secret-scan: Failed to read custom patterns from ${filePath}:`, err)
      return []
    }
  },

  /** Save custom patterns to JSON file */
  async saveCustomPatterns(patterns: CustomSecretPattern[]): Promise<void> {
    const filePath = this._getCustomPatternsPath()
    const dir = dirname(filePath)
    await mkdir(dir, { recursive: true })
    const json = JSON.stringify(patterns, null, 2)
    await writeFile(filePath, json, 'utf-8')
    log.info(`secret-scan: Saved ${patterns.length} custom pattern(s) to ${filePath}`)
  },

  /** Add or update a custom pattern (validates regex, checks broadness) */
  async upsertCustomPattern(
    pattern: CustomSecretPattern
  ): Promise<{ success: boolean; warnings: string[] }> {
    const warnings = validatePatternBroadness(pattern.source, pattern.flags)

    // Validate the regex compiles
    try {
      new RegExp(pattern.source, pattern.flags + 'g')
    } catch (err) {
      return {
        success: false,
        warnings: [`Invalid regex: ${err instanceof Error ? err.message : String(err)}`]
      }
    }

    const patterns = this.getCustomPatterns()
    const idx = patterns.findIndex((p) => p.id === pattern.id)
    if (idx >= 0) {
      patterns[idx] = pattern
    } else {
      patterns.push(pattern)
    }
    await this.saveCustomPatterns(patterns)
    return { success: true, warnings }
  },

  /** Delete a custom pattern by id */
  async deleteCustomPattern(id: string): Promise<void> {
    const patterns = this.getCustomPatterns().filter((p) => p.id !== id)
    await this.saveCustomPatterns(patterns)
  },

  /** Test a regex pattern against a user-provided string */
  testPattern(source: string, flags: string, testString: string): PatternTestResult {
    const warnings = validatePatternBroadness(source, flags)

    let regex: RegExp
    try {
      regex = new RegExp(source, flags + 'g')
    } catch (err) {
      return {
        matches: [],
        matchCount: 0,
        warnings: [`Invalid regex: ${err instanceof Error ? err.message : String(err)}`]
      }
    }

    const matches: string[] = []
    let match: RegExpExecArray | null
    let safety = 0
    while ((match = regex.exec(testString)) !== null && safety < 100) {
      matches.push(match[0])
      safety++
      // Prevent infinite loop on zero-length matches
      if (match[0].length === 0) regex.lastIndex++
    }

    if (safety >= 100) {
      warnings.push('Pattern produced 100+ matches on the test string — likely too broad.')
    }

    return { matches, matchCount: matches.length, warnings }
  }
}
