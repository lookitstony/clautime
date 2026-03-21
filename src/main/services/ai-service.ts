import { eq, and, gte, lte, inArray, type SQL } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { aiSummaries } from '../db/schema/ai-summaries'
import { sessions } from '../db/schema/sessions'
import { gitCommits } from '../db/schema/git-commits'
import { projects } from '../db/schema/projects'
import { credentialService } from './credential-service'
import { settingsService } from './settings-service'
import { DEFAULT_AI_SUMMARY_INSTRUCTIONS } from '../../shared/constants'

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
  }, useAi = true, summaryOptions?: {
    includeOverall?: boolean
    includeDailyBreakdown?: boolean
  }): Promise<string | null> {
    const db = getDb()

    // Build project filter conditions (without date — we filter dates in JS
    // because committedAt may have timezone offsets that break string comparison)
    const conditions: SQL[] = []
    let clientProjectIds: number[] | null = null
    if (filters.projectId != null) {
      conditions.push(eq(gitCommits.projectId, filters.projectId))
    } else if (filters.clientId != null) {
      clientProjectIds = db
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

    const rangeStartMs = new Date(filters.startDate).getTime()
    // Make endDate inclusive of the full day (add 24h minus 1ms)
    const endDate = new Date(filters.endDate)
    if (filters.endDate.length === 10) endDate.setHours(23, 59, 59, 999)
    const rangeEndMs = endDate.getTime()

    const commits = db
      .select()
      .from(gitCommits)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(gitCommits.committedAt)
      .all()
      .filter((c) => {
        const ms = new Date(c.committedAt).getTime()
        return ms >= rangeStartMs && ms <= rangeEndMs
      })

    if (commits.length === 0) {
      log.info('No commits found for report summary')
      return null
    }

    const opts = {
      includeOverall: summaryOptions?.includeOverall ?? true,
      includeDailyBreakdown: summaryOptions?.includeDailyBreakdown ?? false
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

    // Build daily breakdown: attribute commits to every session day
    // A commit covers all working days back to the previous commit.
    // For each session day, find the next commit on or after that day.
    const dailyGrouped = new Map<string, Map<string, string[]>>()
    if (opts.includeDailyBreakdown) {
      // Get session days in the range
      const sessionConditions: SQL[] = [
        lte(sessions.startedAt, filters.endDate),
        gte(sessions.endedAt, filters.startDate)
      ]
      if (filters.projectId != null) {
        sessionConditions.push(eq(sessions.projectId, filters.projectId))
      } else if (filters.clientId != null) {
        sessionConditions.push(eq(sessions.clientId, filters.clientId))
      }
      const rangeSessions = db
        .select()
        .from(sessions)
        .where(and(...sessionConditions))
        .orderBy(sessions.startedAt)
        .all()

      // Collect unique session days with their project info
      const sessionDays = new Map<string, Set<number | null>>() // dateKey -> projectIds
      for (const s of rangeSessions) {
        const d = new Date(s.startedAt)
        const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        if (!sessionDays.has(dateKey)) sessionDays.set(dateKey, new Set())
        sessionDays.get(dateKey)!.add(s.projectId)
      }

      // Sort commits by date for efficient lookup
      const sortedCommits = [...commits].sort((a, b) => a.committedAt.localeCompare(b.committedAt))

      // Build commit date key lookup
      const commitsByDateKey = new Map<string, typeof commits>()
      for (const c of sortedCommits) {
        const d = new Date(c.committedAt)
        const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        if (!commitsByDateKey.has(dk)) commitsByDateKey.set(dk, [])
        commitsByDateKey.get(dk)!.push(c)
      }

      // Get unique commit date keys sorted
      const commitDateKeys = Array.from(commitsByDateKey.keys()).sort()

      // Group session days by which commit they map to, then spread messages evenly
      // commitKey -> list of { dateKey, projectIdSet } that share this commit
      const commitSpans = new Map<string, { dateKey: string; projectIdSet: Set<number | null> }[]>()
      const inProgressDays: { dateKey: string; projectIdSet: Set<number | null> }[] = []

      for (const [dateKey, projectIdSet] of sessionDays) {
        const nextCommitDateKey = commitDateKeys.find((ck) => ck >= dateKey)
        if (nextCommitDateKey) {
          if (!commitSpans.has(nextCommitDateKey)) commitSpans.set(nextCommitDateKey, [])
          commitSpans.get(nextCommitDateKey)!.push({ dateKey, projectIdSet })
        } else {
          inProgressDays.push({ dateKey, projectIdSet })
        }
      }

      // For each commit span, collect messages and split evenly across the days
      for (const [commitDateKey, spanDays] of commitSpans) {
        const dayCommits = commitsByDateKey.get(commitDateKey)!
        // Sort span days chronologically
        spanDays.sort((a, b) => a.dateKey.localeCompare(b.dateKey))

        // Collect unique messages per project, filtered to relevant projects across all span days
        const allProjectIds = new Set<number | null>()
        for (const sd of spanDays) {
          for (const pid of sd.projectIdSet) allProjectIds.add(pid)
        }

        const msgsByProject = new Map<string, string[]>()
        for (const c of dayCommits) {
          const projName = c.projectId != null ? (projectMap.get(c.projectId) ?? 'Unknown') : 'Unknown'
          if (c.projectId != null && !allProjectIds.has(c.projectId) && !allProjectIds.has(null)) continue
          const existing = msgsByProject.get(projName) ?? []
          if (!existing.includes(c.message)) existing.push(c.message)
          msgsByProject.set(projName, existing)
        }

        // Spread messages evenly across span days; if fewer items than days,
        // duplicate the last item to fill remaining days
        const numDays = spanDays.length
        for (const [projName, msgs] of msgsByProject) {
          const perDay = Math.max(1, Math.ceil(msgs.length / numDays))
          for (let i = 0; i < numDays; i++) {
            const slice = msgs.slice(i * perDay, (i + 1) * perDay)
            // If no items left for this day, carry forward the last message
            const items = slice.length > 0 ? slice : [msgs[msgs.length - 1]]
            const sd = spanDays[i]
            const dateLabel = new Date(sd.dateKey + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
            const key = `${sd.dateKey}|${dateLabel}`
            if (!dailyGrouped.has(key)) dailyGrouped.set(key, new Map())
            const dayMap = dailyGrouped.get(key)!
            const existing = dayMap.get(projName) ?? []
            for (const m of items) {
              if (!existing.includes(m)) existing.push(m)
            }
            dayMap.set(projName, existing)
          }
        }
      }

      // Days after the last commit — mark as in progress
      for (const sd of inProgressDays) {
        const dateLabel = new Date(sd.dateKey + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
        const key = `${sd.dateKey}|${dateLabel}`
        if (!dailyGrouped.has(key)) dailyGrouped.set(key, new Map())
        const dayMap = dailyGrouped.get(key)!
        for (const pid of sd.projectIdSet) {
          const projName = pid != null ? (projectMap.get(pid) ?? 'Unknown') : 'Unknown'
          if (!dayMap.has(projName)) dayMap.set(projName, ['(work in progress)'])
        }
      }
    }

    // Try AI summarization if requested and API key is available
    if (useAi) {
      const apiKey = credentialService.getApiKey()
      if (apiKey) {
        const aiSummary = await this._aiSummarizeCommits(apiKey, filters, commits.length, grouped, opts, dailyGrouped)
        if (aiSummary) return aiSummary
      }
    }

    // Fallback: format git commits directly
    log.info(`Building git-only report summary from ${commits.length} commits`)

    const lines: string[] = []

    if (opts.includeOverall) {
      if (opts.includeDailyBreakdown) lines.push('## Overall Summary')
      for (const [, msgs] of grouped) {
        for (const item of groupByTicket(msgs)) lines.push(`- ${item}`)
      }
      lines.push('')
    }

    if (opts.includeDailyBreakdown) {
      if (opts.includeOverall) lines.push('')
      lines.push('## Daily Breakdown')
      lines.push('')
      const sortedDays = Array.from(dailyGrouped.entries()).sort(([a], [b]) => a.localeCompare(b))
      for (const [key, dayMap] of sortedDays) {
        const dateLabel = key.split('|')[1]
        lines.push(`**${dateLabel}**`)
        for (const [, msgs] of dayMap) {
          for (const item of groupByTicket(msgs)) lines.push(`- ${item}`)
        }
        lines.push('')
      }
    }

    return lines.join('\n').trim()
  },

  /** @internal Call Claude API to summarize commit messages grouped by project */
  async _aiSummarizeCommits(
    apiKey: string,
    filters: { startDate: string; endDate: string },
    totalCount: number,
    grouped: Map<string, string[]>,
    opts: { includeOverall: boolean; includeDailyBreakdown: boolean },
    dailyGrouped: Map<string, Map<string, string[]>>
  ): Promise<string | null> {
    const startLabel = new Date(filters.startDate).toLocaleDateString()
    const endLabel = new Date(filters.endDate).toLocaleDateString()

    const commitLines: string[] = []
    const singleProject = grouped.size === 1
    for (const [projName, msgs] of grouped) {
      if (!singleProject) commitLines.push(`Project: ${projName}`)
      for (const item of groupByTicket(msgs)) {
        commitLines.push(`${singleProject ? '- ' : '  - '}${item}`)
      }
      if (!singleProject) commitLines.push('')
    }

    // Add daily commit data if daily breakdown requested
    const dailyLines: string[] = []
    if (opts.includeDailyBreakdown && dailyGrouped.size > 0) {
      const sortedDays = Array.from(dailyGrouped.entries()).sort(([a], [b]) => a.localeCompare(b))
      for (const [key, dayMap] of sortedDays) {
        const dateLabel = key.split('|')[1]
        dailyLines.push(`Date: ${dateLabel}`)
        for (const [projName, msgs] of dayMap) {
          if (!singleProject) dailyLines.push(`  Project: ${projName}`)
          for (const item of groupByTicket(msgs)) dailyLines.push(`${singleProject ? '  ' : '    '}- ${item}`)
        }
        dailyLines.push('')
      }
    }

    const formatInstructions: string[] = []
    if (opts.includeOverall) {
      formatInstructions.push(
        'Write an "## Overall Summary" section:',
        '1. Start with a 1-2 sentence high-level overview of the work done.',
        '2. List specific accomplishments as bullet points (use "- " prefix).',
        '3. Group all work under the same ticket ID into ONE bullet. Summarize the individual commits into a concise description of what was accomplished — do NOT just concatenate commit messages.',
        singleProject
          ? '4. Do NOT mention the project name anywhere — the reader already knows the project.'
          : '4. You may mention project names inline if helpful, but do NOT use project name headers or subgroups.',
      )
    }
    if (opts.includeDailyBreakdown) {
      formatInstructions.push(
        '',
        'Write a "## Daily Breakdown" section:',
        'For each day, use **Day Label** as a header (e.g. **Mon, Mar 10**).',
        'Under each day, list what was accomplished as bullet points (use "- " prefix).',
        'If a ticket appears multiple times in one day, merge into ONE bullet with a concise summary of what was done — do NOT just list or concatenate the commit messages.',
        singleProject
          ? 'Do NOT mention the project name — just the work item description.'
          : 'You may mention project names inline if helpful, but do NOT use project name headers.',
      )
      if (dailyLines.length > 0) {
        formatInstructions.push('', 'Commits by date:', ...dailyLines)
      }
    }

    // Load custom instructions from settings, fall back to default
    const customInstructions = settingsService.getSetting('ai_summary_instructions') || DEFAULT_AI_SUMMARY_INSTRUCTIONS

    const prompt = [
      `Summarize the following work done by an individual contributor during ${startLabel} to ${endLabel}.`,
      'Write from a first-person or neutral perspective — do NOT use "the team" or refer to a team. This is one person\'s work.',
      `There were ${totalCount} commits total${singleProject ? '' : ` across ${grouped.size} projects`}.`,
      '',
      `Commits${singleProject ? '' : ' by project'}:`,
      ...commitLines,
      ...formatInstructions,
      '',
      customInstructions,
      opts.includeOverall && !opts.includeDailyBreakdown
        ? 'Do not include a title or header line — start directly with the overview sentence.'
        : ''
    ].join('\n')

    // Increase max_tokens for daily breakdown
    const maxTokens = opts.includeDailyBreakdown ? 1500 : 500

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
          max_tokens: maxTokens,
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

/** Extract ticket/work item ID from a commit message, or return null. */
function extractTicketId(message: string): string | null {
  // Match patterns like JIRA-123, FEAT-789, BUG-101, PROJ-1234, #456
  const match = message.match(/^([A-Z]+-\d+)\b/i) ?? message.match(/\b([A-Z]{2,}-\d+)\b/i) ?? message.match(/^(#\d+)\b/)
  return match ? match[1].toUpperCase() : null
}


/**
 * Group commit messages by ticket ID. Messages with the same ticket are merged
 * into a single entry: "TICKET-123: description1; description2".
 * Messages without a ticket are returned as-is.
 */
function groupByTicket(messages: string[]): string[] {
  const ticketMap = new Map<string, string[]>()
  const noTicket: string[] = []

  for (const msg of messages) {
    const ticket = extractTicketId(msg)
    if (ticket) {
      const cleaned = msg.replace(new RegExp(`\\s*${ticket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[:\\s-]*`, 'i'), '').trim()
      const desc = cleaned || msg
      const existing = ticketMap.get(ticket) ?? []
      if (!existing.includes(desc)) existing.push(desc)
      ticketMap.set(ticket, existing)
    } else {
      if (!noTicket.includes(msg)) noTicket.push(msg)
    }
  }

  const result: string[] = []
  for (const [ticket, descs] of ticketMap) {
    result.push(`${ticket}: ${descs.join('; ')}`)
  }
  result.push(...noTicket)
  return result
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
