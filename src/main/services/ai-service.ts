import { eq, and, gte, lte, inArray, type SQL } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { aiSummaries } from '../db/schema/ai-summaries'
import { sessions } from '../db/schema/sessions'
import { gitCommits } from '../db/schema/git-commits'
import { projects } from '../db/schema/projects'
import { credentialService } from './credential-service'

interface SummaryResult {
  summary: string
  tier: 'ai' | 'git' | 'none'
}

/**
 * AIService generates summaries for sessions using Claude API,
 * with fallback to git commits and then to no summary.
 */
export const aiService = {
  /**
   * Get or generate a summary for a session (three-tier fallback).
   * Tier 1: Cached AI summary
   * Tier 2: Git commit messages
   * Tier 3: No summary available
   */
  async getSessionSummary(sessionId: number): Promise<SummaryResult> {
    const db = getDb()

    // Tier 1: Check for cached AI summary
    const cached = db
      .select()
      .from(aiSummaries)
      .where(eq(aiSummaries.sessionId, sessionId))
      .get()

    if (cached) {
      return { summary: cached.summary, tier: 'ai' }
    }

    // Tier 2: Git commits as description
    const commits = db
      .select()
      .from(gitCommits)
      .where(eq(gitCommits.sessionId, sessionId))
      .orderBy(gitCommits.committedAt)
      .all()

    if (commits.length > 0) {
      const summary = commits.map((c) => c.message).join('; ')
      return { summary, tier: 'git' }
    }

    // Tier 3: No summary
    return { summary: '', tier: 'none' }
  },

  /**
   * Generate an AI summary for a session using the Claude API.
   * Requires a valid API key to be configured.
   */
  async generateSummary(sessionId: number): Promise<string | null> {
    const apiKey = credentialService.getApiKey()
    if (!apiKey) {
      log.warn('Cannot generate summary: no API key configured')
      return null
    }

    const db = getDb()
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()
    if (!session) return null

    // Gather context
    const project = session.projectId
      ? db.select().from(projects).where(eq(projects.id, session.projectId)).get()
      : null

    const commits = db
      .select()
      .from(gitCommits)
      .where(eq(gitCommits.sessionId, sessionId))
      .all()

    const prompt = buildPrompt(session, project?.name ?? null, commits)

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [
            { role: 'user', content: prompt }
          ]
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        log.error(`AI API error (${response.status}):`, errorText)
        return null
      }

      const data = await response.json()
      const summary =
        data.content?.[0]?.type === 'text' ? data.content[0].text : null

      if (summary) {
        // Cache the summary
        db.insert(aiSummaries)
          .values({
            sessionId,
            summary,
            model: 'claude-haiku-4-5-20251001',
            createdAt: new Date().toISOString()
          })
          .run()

        log.info(`Generated and cached AI summary for session ${sessionId}`)
      }

      return summary
    } catch (error) {
      log.error('Failed to generate AI summary:', error)
      return null
    }
  },

  /**
   * Generate summaries for multiple sessions in batch.
   * Returns the number of successfully generated summaries.
   */
  async generateBatchSummaries(
    sessionIds: number[],
    onProgress?: (current: number, total: number) => void
  ): Promise<number> {
    let generated = 0
    for (let i = 0; i < sessionIds.length; i++) {
      onProgress?.(i + 1, sessionIds.length)
      const result = await this.generateSummary(sessionIds[i])
      if (result) generated++
      // Small delay to avoid rate limiting
      if (i < sessionIds.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    return generated
  },

  /**
   * Get cached summary for a session (no generation).
   */
  getCachedSummary(sessionId: number) {
    const db = getDb()
    return db
      .select()
      .from(aiSummaries)
      .where(eq(aiSummaries.sessionId, sessionId))
      .get() ?? null
  },

  /**
   * Generate an AI summary for a report by summarizing all git commit messages
   * in the given date range (and optional project/client filters).
   */
  async generateReportSummary(filters: {
    startDate: string
    endDate: string
    projectId?: number
    clientId?: number
  }, useAi = true): Promise<string | null> {
    const db = getDb()

    const conditions: SQL[] = [
      gte(gitCommits.committedAt, filters.startDate),
      lte(gitCommits.committedAt, filters.endDate)
    ]
    if (filters.projectId != null) {
      conditions.push(eq(gitCommits.projectId, filters.projectId))
    } else if (filters.clientId != null) {
      const clientProjectIds = db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.clientId, filters.clientId))
        .all()
        .map((p) => p.id)
      if (clientProjectIds.length === 0) {
        log.info('No projects found for client, no commits to summarize')
        return null
      }
      conditions.push(inArray(gitCommits.projectId, clientProjectIds))
    }

    const commits = db
      .select()
      .from(gitCommits)
      .where(and(...conditions))
      .orderBy(gitCommits.committedAt)
      .all()

    if (commits.length === 0) {
      log.info('No commits found for report summary')
      return null
    }

    // Group commits by project
    const projectIds = [...new Set(commits.filter((c) => c.projectId != null).map((c) => c.projectId!))]
    const projectMap = new Map<number, string>()
    if (projectIds.length > 0) {
      const allProjects = db.select().from(projects).all()
      for (const p of allProjects) projectMap.set(p.id, p.name)
    }

    const grouped = new Map<string, string[]>()
    for (const c of commits) {
      const projName = c.projectId != null ? (projectMap.get(c.projectId) ?? 'Unknown') : 'Unknown'
      const existing = grouped.get(projName) ?? []
      if (!existing.includes(c.message)) existing.push(c.message)
      grouped.set(projName, existing)
    }

    // Try AI summarization if requested and API key is available
    if (useAi) {
      const apiKey = credentialService.getApiKey()
      if (apiKey) {
        const aiSummary = await this._aiSummarizeCommits(apiKey, filters, commits.length, grouped)
        if (aiSummary) return aiSummary
      }
    }

    // Fallback: format git commits directly grouped by project
    log.info(`Building git-only report summary from ${commits.length} commits`)

    const lines: string[] = []
    for (const [projName, msgs] of grouped) {
      lines.push(`**${projName}**`)
      for (const msg of msgs) {
        lines.push(`- ${msg}`)
      }
      lines.push('')
    }

    return lines.join('\n').trim()
  },

  /** @internal Call Claude API to summarize commit messages grouped by project */
  async _aiSummarizeCommits(
    apiKey: string,
    filters: { startDate: string; endDate: string },
    totalCount: number,
    grouped: Map<string, string[]>
  ): Promise<string | null> {
    const startLabel = new Date(filters.startDate).toLocaleDateString()
    const endLabel = new Date(filters.endDate).toLocaleDateString()

    const commitLines: string[] = []
    for (const [projName, msgs] of grouped) {
      commitLines.push(`Project: ${projName}`)
      for (const msg of msgs) {
        commitLines.push(`  - ${msg}`)
      }
      commitLines.push('')
    }

    const prompt = [
      `Summarize the following work done during ${startLabel} to ${endLabel}.`,
      `There were ${totalCount} commits total across ${grouped.size} project${grouped.size !== 1 ? 's' : ''}.`,
      '',
      'Commits by project:',
      ...commitLines,
      'Write a professional summary of the work accomplished in this format:',
      '1. Start with a 1-2 sentence high-level overview of the work done.',
      '2. Then break down accomplishments by project, using **Project Name** as headers.',
      '3. Under each project, list specific accomplishments as bullet points (use "- " prefix).',
      'Focus on what was built, fixed, or improved.',
      'Do not include commit hashes, timestamps, or technical jargon unless relevant.',
      'Do not include a title or header line — start directly with the overview sentence.'
    ].join('\n')

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }]
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        log.error(`Report summary API error (${response.status}):`, errorText)
        return null
      }

      const data = await response.json()
      const summary = data.content?.[0]?.type === 'text' ? data.content[0].text : null

      if (summary) {
        log.info(`Generated AI report summary from ${totalCount} commits`)
      }

      return summary
    } catch (error) {
      log.error('Failed to generate AI report summary:', error)
      return null
    }
  }
}

function buildPrompt(
  session: typeof sessions.$inferSelect,
  projectName: string | null,
  commits: (typeof gitCommits.$inferSelect)[]
): string {
  const parts = [
    'Summarize this work session in 1-3 concise sentences.',
    `Project: ${projectName ?? 'Unknown'}`,
    `Duration: ${session.durationMinutes} minutes`,
    `Time: ${session.startedAt} to ${session.endedAt}`,
    `Prompts: ${session.promptCount}`
  ]

  if (commits.length > 0) {
    parts.push('Git commits during this session:')
    for (const c of commits.slice(0, 10)) {
      parts.push(`- ${c.message}`)
    }
  }

  parts.push(
    'Write a professional, concise summary focusing on what was accomplished. Do not include timestamps or metadata.'
  )

  return parts.join('\n')
}
