// @vitest-environment node
import { expect, it } from 'vitest'
import type { CanonicalIntervalCoverage } from './canonical-intervals'
import {
  deletedCoverageFragment,
  portableCoverageBounds,
  portableCoverageHash
} from './folder-sync-portable-coverage'

const at = (minute: number): string =>
  new Date(Date.UTC(2026, 8, 1, 9, 0) + minute * 60_000).toISOString()
const hex = (n: number): string => n.toString(16).padStart(64, '0')
const observation = (n: number): string => `observation:v1:${hex(n)}`
const message = (n: number, minute: number, observations = [observation(n)]) => ({
  eventId: `codex:v1:native:${hex(n)}`,
  observationId: [...observations].sort()[0],
  observationIds: observations,
  kind: 'message' as const,
  timestamp: at(minute)
})

function codex(observations = [observation(2)], output = 10): CanonicalIntervalCoverage {
  return {
    version: 2,
    messages: [message(1, 0), message(2, 5, observations)],
    continuity: [],
    usage: observations.map((observationId) => ({
      checkpointId: `codex:v1:checkpoint:${hex(9)}`,
      observationId,
      messageEventId: `codex:v1:native:${hex(2)}`,
      timestamp: at(5),
      model: 'gpt-5',
      delta: { output_tokens: output, input_tokens: 100 },
      usage: {
        inputTokens: 100,
        outputTokens: output,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      }
    }))
  }
}
const hash = (coverage: CanonicalIntervalCoverage) =>
  portableCoverageHash('codex', 'thread', coverage)

it('hashes the measurement, not which observations reported it', () => {
  const original = hash(codex())
  // A second log of the same conversation (or another computer's copy) reports the same facts.
  expect(hash(codex([observation(2), observation(7)]))).toBe(original)
  expect(hash(codex([observation(7)]))).toBe(original)

  // Changed usage, a moved event or another conversation is a different measurement.
  expect(hash(codex([observation(2)], 11))).not.toBe(original)
  const moved = codex()
  moved.messages[1] = message(2, 6)
  expect(hash(moved)).not.toBe(original)
  expect(portableCoverageHash('codex', 'other', codex())).not.toBe(original)
})

it('rebuilds a deleted piece that starts at a cut inside a continuity span', () => {
  const from = message(1, 0)
  const to = message(2, 30)
  const piece: CanonicalIntervalCoverage = {
    version: 1,
    messages: [{ ...to, observationIds: undefined }],
    continuity: [{ from, to, startedAt: at(20), endedAt: at(30), progress: [] }]
  }
  expect(portableCoverageBounds(piece)).toEqual({ startedAt: at(20), endedAt: at(30) })
  expect(deletedCoverageFragment(piece)).toEqual({ startedAt: at(20), coverage: piece })
  expect(deletedCoverageFragment({ version: 1, messages: [], continuity: [] })).toBeNull()
})
