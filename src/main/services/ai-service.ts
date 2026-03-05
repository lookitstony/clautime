import { eq } from 'drizzle-orm'
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
