import { createHash } from 'node:crypto'
import type { CanonicalEventReference } from './canonical-activity'
import type { CodexUsageReference } from './canonical-codex'
import type { CanonicalIntervalCoverage } from './canonical-intervals'

/*
 * Portable views of canonical coverage for shared session records (folder-sync-plan.md decisions
 * C and D). Observation IDs say which source copy reported an event; they differ between
 * computers and grow as more logs of one conversation are seen, so they never identify measured
 * coverage here. Everything that measures time or tokens (events, kinds, timestamps, continuity
 * spans, progress, and each usage checkpoint's counters, owner and model) does.
 */

const eventKey = (item: CanonicalEventReference) => [item.eventId, item.kind, item.timestamp]

/** One usage checkpoint's measurement; the observation that reported it is excluded. */
function usageKey(entry: CodexUsageReference): string {
  return JSON.stringify([
    entry.checkpointId,
    entry.messageEventId,
    entry.timestamp,
    entry.model,
    Object.entries(entry.delta).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    entry.usage.inputTokens,
    entry.usage.outputTokens,
    entry.usage.cacheCreationInputTokens,
    entry.usage.cacheReadInputTokens
  ])
}

/**
 * Hash of the measured coverage for PortableTimeOverride.baseCoverageHash. Equal on every
 * computer for the same measurement whatever observations reported it; any change to an event,
 * span or usage checkpoint changes it. Not interchangeable with session-mapping-plan's local
 * coverageHash.
 */
export function portableCoverageHash(
  provider: string,
  conversationId: string,
  coverage: CanonicalIntervalCoverage
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        purpose: 'clautime-portable-coverage-1',
        version: coverage.version,
        provider,
        conversationId,
        messages: coverage.messages.map(eventKey),
        continuity: coverage.continuity.map((edge) => [
          eventKey(edge.from),
          eventKey(edge.to),
          edge.startedAt,
          edge.endedAt,
          edge.progress.map(eventKey)
        ]),
        // Replicas of one checkpoint collapse; the set, not the report order, is the measurement.
        ...(coverage.version === 2
          ? { usage: [...new Set((coverage.usage ?? []).map(usageKey))].sort() }
          : {})
      })
    )
    .digest('hex')
}

/** Earliest and latest instant the coverage counts (messages and continuity spans). */
export function portableCoverageBounds(
  coverage: CanonicalIntervalCoverage
): { startedAt: string; endedAt: string } | null {
  const instants = [
    ...coverage.messages.map((item) => Date.parse(item.timestamp)),
    ...coverage.continuity.flatMap((edge) => [Date.parse(edge.startedAt), Date.parse(edge.endedAt)])
  ].filter(Number.isFinite)
  if (!instants.length) return null
  return {
    startedAt: new Date(Math.min(...instants)).toISOString(),
    endedAt: new Date(Math.max(...instants)).toISOString()
  }
}

/**
 * The fragment a deletion fact removed, rebuilt from its coverage alone (the fact carries no
 * start). A cut partition truncates a continuity span at the cut and keeps a message at the cut in
 * the later piece, so a piece that started at a cut has that cut as its lower bound and cut
 * anchors attach to it exactly as they did before the deletion. A cut inside an uncounted gap
 * cannot be recovered from coverage; such an anchor stays unattached and is reported, never
 * dropped.
 */
export function deletedCoverageFragment(
  coverage: CanonicalIntervalCoverage
): { startedAt: string; coverage: CanonicalIntervalCoverage } | null {
  const bounds = portableCoverageBounds(coverage)
  return bounds ? { startedAt: bounds.startedAt, coverage } : null
}
