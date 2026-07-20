/**
 * Deterministic sample dataset for the browser demo (docs/demo).
 * Everything is generated relative to "now" so the Live page always looks
 * current, but the RNG is seeded so the numbers are stable within a visit.
 */
import type { Session, SessionModelUsage } from '../../../shared/types/session'
import type { Client, Project } from '../../../shared/types/client-project'
import type { GitCommit } from '../../../shared/types/git'
import type { LocalInvoiceDetail } from '../../../shared/types/invoice'
import type { SecretFinding, CustomSecretPattern } from '../../../shared/types/secret-scan'

// ── seeded RNG ──
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20260710)
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]
const randInt = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1))

const now = new Date()
const iso = (d: Date): string => d.toISOString()

// ── clients ──
export const clients: Client[] = [
  {
    id: 1,
    name: 'Acme Robotics',
    stageName: null,
    color: 'var(--project-1)',
    billableRate: 120,
    email: 'billing@acmerobotics.com',
    stripeCustomerId: 'cus_DemoAcme001',
    isActive: true,
    createdAt: iso(new Date(now.getTime() - 90 * 864e5)),
    updatedAt: iso(new Date(now.getTime() - 5 * 864e5))
  },
  {
    id: 2,
    name: 'Northwind Digital',
    stageName: null,
    color: 'var(--project-4)',
    billableRate: 95,
    email: 'accounts@northwind.io',
    stripeCustomerId: 'cus_DemoNorth002',
    isActive: true,
    createdAt: iso(new Date(now.getTime() - 75 * 864e5)),
    updatedAt: iso(new Date(now.getTime() - 12 * 864e5))
  },
  {
    id: 3,
    name: 'Internal',
    stageName: null,
    color: 'var(--project-6)',
    billableRate: null,
    email: null,
    stripeCustomerId: null,
    isActive: true,
    createdAt: iso(new Date(now.getTime() - 90 * 864e5)),
    updatedAt: iso(new Date(now.getTime() - 90 * 864e5))
  }
]

// ── projects ──
export const projects: Project[] = [
  {
    id: 1,
    clientId: 1,
    name: 'checkout-api',
    invoiceName: 'Checkout API Development',
    stageName: null,
    hourlyRate: null,
    directoryPath: '/Users/demo/work/acme/checkout-api',
    isBillable: true,
    isActive: true,
    createdAt: iso(new Date(now.getTime() - 88 * 864e5)),
    updatedAt: iso(new Date(now.getTime() - 2 * 864e5))
  },
  {
    id: 2,
    clientId: 1,
    name: 'mobile-app',
    invoiceName: 'Mobile App',
    stageName: null,
    hourlyRate: 135,
    directoryPath: '/Users/demo/work/acme/mobile-app',
    isBillable: true,
    isActive: true,
    createdAt: iso(new Date(now.getTime() - 60 * 864e5)),
    updatedAt: iso(new Date(now.getTime() - 3 * 864e5))
  },
  {
    id: 3,
    clientId: 2,
    name: 'marketing-site',
    invoiceName: null,
    stageName: null,
    hourlyRate: null,
    directoryPath: '/Users/demo/work/northwind/marketing-site',
    isBillable: true,
    isActive: true,
    createdAt: iso(new Date(now.getTime() - 70 * 864e5)),
    updatedAt: iso(new Date(now.getTime() - 8 * 864e5))
  },
  {
    id: 4,
    clientId: 2,
    name: 'data-pipeline',
    invoiceName: 'ETL / Data Pipeline',
    stageName: null,
    hourlyRate: 110,
    directoryPath: '/Users/demo/work/northwind/data-pipeline',
    isBillable: true,
    isActive: true,
    createdAt: iso(new Date(now.getTime() - 45 * 864e5)),
    updatedAt: iso(new Date(now.getTime() - 1 * 864e5))
  },
  {
    id: 5,
    clientId: 3,
    name: 'dotfiles',
    invoiceName: null,
    stageName: null,
    hourlyRate: null,
    directoryPath: '/Users/demo/personal/dotfiles',
    isBillable: false,
    isActive: true,
    createdAt: iso(new Date(now.getTime() - 80 * 864e5)),
    updatedAt: iso(new Date(now.getTime() - 6 * 864e5))
  }
]

export function effectiveRate(projectId: number | null, clientId: number | null): number | null {
  const project = projects.find((p) => p.id === projectId)
  if (project?.hourlyRate != null) return project.hourlyRate
  const client = clients.find((c) => c.id === (clientId ?? project?.clientId))
  return client?.billableRate ?? null
}

// ── sessions ──
const MODELS = ['claude-fable-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001']

export const sessions: Session[] = []
export const sessionModelUsage = new Map<number, SessionModelUsage[]>()

function makeModelUsage(inputTokens: number, outputTokens: number): SessionModelUsage[] {
  const primary = rand() < 0.65 ? MODELS[0] : MODELS[1]
  const usage: SessionModelUsage[] = [
    {
      model: primary,
      inputTokens: Math.round(inputTokens * 0.85),
      outputTokens: Math.round(outputTokens * 0.9),
      cacheCreationInputTokens: Math.round(inputTokens * 2.1),
      cacheReadInputTokens: Math.round(inputTokens * 24)
    }
  ]
  if (rand() < 0.5) {
    usage.push({
      model: MODELS[2],
      inputTokens: Math.round(inputTokens * 0.15),
      outputTokens: Math.round(outputTokens * 0.1),
      cacheCreationInputTokens: Math.round(inputTokens * 0.2),
      cacheReadInputTokens: Math.round(inputTokens * 1.5)
    })
  }
  return usage
}

const manualDescriptions = [
  'Sprint planning + architecture discussion',
  'Client call — reviewed milestone 2 deliverables',
  'Pair debugging session (screen share)',
  'Code review and release checklist'
]

let sessionId = 1
function addSession(start: Date, durationMinutes: number, projectId: number, source: 'auto' | 'manual' = 'auto'): Session {
  const project = projects.find((p) => p.id === projectId)!
  const end = new Date(start.getTime() + durationMinutes * 60000)
  const promptCount = source === 'manual' ? 0 : Math.max(2, Math.round(durationMinutes / randInt(3, 6)))
  const inputTokens = source === 'manual' ? 0 : promptCount * randInt(700, 1600)
  const outputTokens = source === 'manual' ? 0 : promptCount * randInt(1800, 3400)
  const s: Session = {
    id: sessionId++,
    projectPath: project.directoryPath,
    startedAt: iso(start),
    endedAt: iso(end),
    durationMinutes,
    source,
    description: source === 'manual' ? pick(manualDescriptions) : null,
    status: 'completed',
    tool: 'claude',
    claudeSessionId: source === 'auto' ? `demo-${s36(sessionId)}-${s36(Math.floor(rand() * 1e9))}` : null,
    promptCount,
    inputTokens,
    outputTokens,
    sourceFile: source === 'auto' ? `~/.claude/projects/${project.directoryPath.replace(/[/\\.]/g, '-')}/session.jsonl` : null,
    billable: project.isBillable,
    projectId: project.id,
    clientId: project.clientId,
    createdAt: iso(end),
    updatedAt: iso(end)
  }
  if (source === 'auto') sessionModelUsage.set(s.id, makeModelUsage(inputTokens, outputTokens))
  sessions.push(s)
  return s
}
function s36(n: number): string {
  return n.toString(36).padStart(6, '0')
}

// weighted project choice
function pickProject(): number {
  const r = rand()
  if (r < 0.3) return 1
  if (r < 0.5) return 2
  if (r < 0.7) return 3
  if (r < 0.87) return 4
  return 5
}

// Generate ~6 weeks of history (covers "last month" for invoices/analytics).
for (let offset = 44; offset >= 1; offset--) {
  const day = new Date(now)
  day.setDate(day.getDate() - offset)
  const dow = day.getDay()
  const isWeekend = dow === 0 || dow === 6
  if (isWeekend && rand() > 0.3) continue
  const count = isWeekend ? 1 : randInt(2, 4)
  let cursor = new Date(day)
  cursor.setHours(randInt(8, 10), randInt(0, 59), 0, 0)
  for (let i = 0; i < count; i++) {
    const duration = randInt(25, 150)
    addSession(new Date(cursor), duration, pickProject(), rand() < 0.06 ? 'manual' : 'auto')
    cursor = new Date(cursor.getTime() + (duration + randInt(20, 120)) * 60000)
    if (cursor.getHours() >= 21) break
  }
  // occasional late-night after-hours session
  if (!isWeekend && rand() < 0.18) {
    const late = new Date(day)
    late.setHours(randInt(20, 22), randInt(0, 59), 0, 0)
    addSession(late, randInt(20, 75), pickProject())
  }
}

// Today: a realistic in-progress day ending "just now".
const today9 = new Date(now)
today9.setHours(9, 12, 0, 0)
if (now.getHours() >= 10) addSession(today9, 84, 1)
const today11 = new Date(now)
today11.setHours(11, 5, 0, 0)
if (now.getHours() >= 13) addSession(today11, 66, 3)
const today14 = new Date(now)
today14.setHours(14, 20, 0, 0)
if (now.getHours() >= 16) addSession(today14, 47, 4)
// current session on checkout-api, ends 2 minutes ago
{
  const recentDur = 38
  const start = new Date(now.getTime() - (recentDur + 2) * 60000)
  if (start.getHours() >= 7) addSession(start, recentDur, 1)
  else addSession(new Date(now.getTime() - 30 * 60000), 28, 1)
}

// ── AI summaries ──
const summaryTexts = [
  'Implemented OAuth token refresh with automatic retry on 401s; added integration tests covering expired and revoked tokens.',
  'Refactored the payment webhook handler into idempotent processors and fixed a race condition on duplicate Stripe events.',
  'Built the CSV export pipeline for order history, streaming rows to avoid loading full result sets into memory.',
  'Debugged flaky checkout E2E tests — root cause was a stale service worker cache; added cache-busting on deploy.',
  'Added dark-mode support across the settings screens and normalized color tokens into the shared theme file.',
  'Migrated the sessions table to include per-model token usage; wrote the backfill script and verified row counts.',
  'Tuned the ETL batch size and parallelism, cutting the nightly pipeline run from 42 to 17 minutes.',
  'Wrote onboarding wizard copy and wired up the folder-picker flow with validation for missing project dirs.',
  'Fixed responsive layout regressions on the pricing page and added visual regression snapshots.',
  'Hardened API input validation with zod schemas and returned structured error codes for the mobile client.'
]
export const aiSummaries = new Map<number, string>()
for (const s of sessions) {
  if (s.source === 'auto' && s.promptCount >= 8 && rand() < 0.7) {
    aiSummaries.set(s.id, summaryTexts[s.id % summaryTexts.length])
  }
}

// ── git commits ──
const commitMessages = [
  'Add retry with exponential backoff to payment client',
  'Fix duplicate webhook processing race',
  'Extract checkout totals into pure calculator module',
  'Add integration tests for refund flow',
  'Bump deps and fix breaking changes in stripe sdk',
  'Stream CSV export instead of buffering rows',
  'Add dark mode theme tokens',
  'Migrate sessions schema for per-model usage',
  'Speed up nightly ETL batching',
  'Validate request bodies with zod',
  'Fix mobile nav overflow on small screens',
  'Add e2e coverage for guest checkout',
  'Cache product catalog lookups',
  'Improve error messages on failed imports',
  'Refactor auth middleware into composable guards'
]
export const gitCommits: GitCommit[] = []
let commitId = 1
for (const s of sessions) {
  if (s.source !== 'auto' || s.projectId === 5 || s.durationMinutes < 40 || rand() > 0.55) continue
  const n = randInt(1, 3)
  for (let i = 0; i < n; i++) {
    const at = new Date(new Date(s.startedAt).getTime() + rand() * s.durationMinutes * 60000)
    gitCommits.push({
      id: commitId++,
      projectId: s.projectId,
      hash: Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join(''),
      message: pick(commitMessages),
      authorName: 'Alex Rivera',
      authorEmail: 'alex@rivera.dev',
      committedAt: iso(at),
      sessionId: s.id,
      createdAt: iso(at)
    })
  }
}

// ── settings ──
export const settings: Record<string, string> = {
  setup_complete: 'true',
  presentation_mode: 'false',
  after_hours_mode: 'false',
  idle_timeout_minutes: '15',
  claude_dir: '~/.claude',
  alert_threshold_mode: 'percent',
  widget_glow_enabled: 'true',
  desktop_alerts_enabled: 'true',
  secret_scan_mode: 'monitor',
  notification_volume: '0.6',
  git_ignored_author_emails: 'bot@dependabot.com'
}

// ── secret scan ──
export const secretFindings: SecretFinding[] = [
  {
    id: 1,
    sourceFile: '~/.claude/projects/-Users-demo-work-acme-checkout-api/a1b2.jsonl',
    lineNumber: 482,
    secretType: 'Anthropic API Key',
    redactedPreview: 'sk-ant-api03-Xk4••••••••••••••••••••3fQ',
    severity: 'critical',
    context: 'export ANTHROPIC_API_KEY=sk-ant-api03-Xk4•••',
    scannedAt: iso(new Date(now.getTime() - 2 * 864e5)),
    status: 'found',
    redactedAt: null,
    occurrences: 2
  },
  {
    id: 2,
    sourceFile: '~/.claude/projects/-Users-demo-work-northwind-data-pipeline/c3d4.jsonl',
    lineNumber: 1051,
    secretType: 'AWS Access Key ID',
    redactedPreview: 'AKIA••••••••••••QY7Z',
    severity: 'high',
    context: 'aws_access_key_id = AKIA•••',
    scannedAt: iso(new Date(now.getTime() - 2 * 864e5)),
    status: 'found',
    redactedAt: null,
    occurrences: 1
  },
  {
    id: 3,
    sourceFile: '~/.claude/projects/-Users-demo-work-acme-mobile-app/e5f6.jsonl',
    lineNumber: 233,
    secretType: 'GitHub Personal Access Token',
    redactedPreview: 'ghp_9m••••••••••••••••••••Wt2',
    severity: 'high',
    context: 'git remote set-url origin https://ghp_9m•••@github.com/...',
    scannedAt: iso(new Date(now.getTime() - 2 * 864e5)),
    status: 'found',
    redactedAt: null,
    occurrences: 1
  },
  {
    id: 4,
    sourceFile: '~/.claude/projects/-Users-demo-work-northwind-marketing-site/g7h8.jsonl',
    lineNumber: 77,
    secretType: 'Postgres Connection String',
    redactedPreview: 'postgres://app:••••••@db.internal:5432/prod',
    severity: 'high',
    context: 'DATABASE_URL=postgres://app:•••',
    scannedAt: iso(new Date(now.getTime() - 9 * 864e5)),
    status: 'redacted',
    redactedAt: iso(new Date(now.getTime() - 9 * 864e5)),
    occurrences: 3
  },
  {
    id: 5,
    sourceFile: '~/.claude/projects/-Users-demo-work-acme-checkout-api/i9j0.jsonl',
    lineNumber: 615,
    secretType: 'Stripe Secret Key',
    redactedPreview: 'sk_test_51••••••••••••••••••••hR8',
    severity: 'critical',
    context: 'STRIPE_SECRET_KEY=sk_test_51•••',
    scannedAt: iso(new Date(now.getTime() - 9 * 864e5)),
    status: 'redacted',
    redactedAt: iso(new Date(now.getTime() - 8 * 864e5)),
    occurrences: 1
  },
  {
    id: 6,
    sourceFile: '~/.claude/projects/-Users-demo-personal-dotfiles/k1l2.jsonl',
    lineNumber: 19,
    secretType: 'JWT Token',
    redactedPreview: 'eyJhbGciOi••••••••••••••••••••x0k',
    severity: 'medium',
    context: 'Authorization: Bearer eyJhbGciOi•••',
    scannedAt: iso(new Date(now.getTime() - 15 * 864e5)),
    status: 'ignored',
    redactedAt: null,
    occurrences: 4
  },
  {
    id: 7,
    sourceFile: '~/.claude/projects/-Users-demo-work-northwind-data-pipeline/m3n4.jsonl',
    lineNumber: 902,
    secretType: 'Generic Password Assignment',
    redactedPreview: 'SMTP_PASSWORD=••••••••',
    severity: 'medium',
    context: 'SMTP_PASSWORD=•••',
    scannedAt: iso(new Date(now.getTime() - 15 * 864e5)),
    status: 'redacted',
    redactedAt: iso(new Date(now.getTime() - 15 * 864e5)),
    occurrences: 1
  }
]

export const customPatterns: CustomSecretPattern[] = [
  {
    id: 'demo-internal-token',
    label: 'Acme internal service token',
    source: 'acme_svc_[A-Za-z0-9]{24}',
    flags: 'g',
    severity: 'high',
    redactLabel: 'ACME_SERVICE_TOKEN',
    enabled: true
  }
]

// ── invoices (seeded history; more are created live in the demo) ──
function lastMonthRange(): { start: string; end: string } {
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const last = new Date(now.getFullYear(), now.getMonth(), 0)
  const fmt = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { start: fmt(first), end: fmt(last) }
}
export const seedInvoicePeriod = lastMonthRange()

export const invoices: LocalInvoiceDetail[] = []

export const availableSounds = [
  { name: 'System Default', filename: 'system' },
  { name: 'Chime', filename: 'chime.wav' },
  { name: 'Ping', filename: 'ping.wav' },
  { name: 'Soft Bell', filename: 'soft-bell.wav' }
]
