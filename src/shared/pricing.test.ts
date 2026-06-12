// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getModelPricing, estimateCostUsd, type TokenCounts } from './pricing'

function tokens(overrides: Partial<TokenCounts> = {}): TokenCounts {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...overrides
  }
}

describe('getModelPricing', () => {
  it('matches Opus models by prefix', () => {
    const p = getModelPricing('claude-opus-4-6')
    expect(p.displayName).toBe('Opus')
    expect(p.inputPerMTok).toBe(5)
    expect(p.outputPerMTok).toBe(25)
  })

  it('matches Sonnet models by prefix', () => {
    const p = getModelPricing('claude-sonnet-4-5-20250929')
    expect(p.displayName).toBe('Sonnet')
    expect(p.inputPerMTok).toBe(3)
    expect(p.outputPerMTok).toBe(15)
  })

  it('matches Haiku models by prefix (new naming)', () => {
    const p = getModelPricing('claude-haiku-4-5')
    expect(p.displayName).toBe('Haiku')
    expect(p.inputPerMTok).toBe(1)
    expect(p.outputPerMTok).toBe(5)
  })

  it('matches Haiku models with older 3.x naming conventions', () => {
    expect(getModelPricing('claude-3-5-haiku-20241022').displayName).toBe('Haiku')
    expect(getModelPricing('claude-3-haiku-20240307').displayName).toBe('Haiku')
  })

  it('matches Fable models by prefix', () => {
    const p = getModelPricing('claude-fable-5')
    expect(p.displayName).toBe('Fable 5')
    expect(p.inputPerMTok).toBe(10)
    expect(p.outputPerMTok).toBe(50)
  })

  it('matches Mythos models by prefix', () => {
    expect(getModelPricing('claude-mythos-5-20260101').displayName).toBe('Mythos 5')
  })

  it('falls back to Opus rates for unknown model strings', () => {
    const p = getModelPricing('gpt-9-mega')
    expect(p.displayName).toBe('Unknown (Opus rates)')
    expect(p.inputPerMTok).toBe(5)
    expect(p.outputPerMTok).toBe(25)
  })

  it('falls back for the "unknown" bucket used by the detector', () => {
    expect(getModelPricing('unknown').displayName).toBe('Unknown (Opus rates)')
  })

  it('falls back for null, undefined, and empty string', () => {
    expect(getModelPricing(null).displayName).toBe('Unknown (Opus rates)')
    expect(getModelPricing(undefined).displayName).toBe('Unknown (Opus rates)')
    expect(getModelPricing('').displayName).toBe('Unknown (Opus rates)')
  })
})

describe('estimateCostUsd', () => {
  it('computes input + output cost at model rates (Sonnet)', () => {
    const cost = estimateCostUsd(
      'claude-sonnet-4-5',
      tokens({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
    )
    expect(cost).toBeCloseTo(3 + 15, 10)
  })

  it('bills cache writes at 1.25x the input rate', () => {
    const cost = estimateCostUsd(
      'claude-sonnet-4-5',
      tokens({ cacheCreationInputTokens: 1_000_000 })
    )
    expect(cost).toBeCloseTo(3 * 1.25, 10)
  })

  it('bills cache reads at 0.1x the input rate', () => {
    const cost = estimateCostUsd('claude-sonnet-4-5', tokens({ cacheReadInputTokens: 1_000_000 }))
    expect(cost).toBeCloseTo(3 * 0.1, 10)
  })

  it('sums all four token categories (Opus)', () => {
    const cost = estimateCostUsd(
      'claude-opus-4-6',
      tokens({
        inputTokens: 2_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        cacheReadInputTokens: 10_000_000
      })
    )
    // 2*5 + 1*25 + 1*5*1.25 + 10*5*0.1 = 10 + 25 + 6.25 + 5 = 46.25
    expect(cost).toBeCloseTo(46.25, 10)
  })

  it('scales linearly for small token counts (Haiku)', () => {
    const cost = estimateCostUsd(
      'claude-haiku-4-5',
      tokens({ inputTokens: 500, outputTokens: 1000 })
    )
    // 500 * 1/1M + 1000 * 5/1M = 0.0005 + 0.005
    expect(cost).toBeCloseTo(0.0055, 10)
  })

  it('uses Opus fallback rates for null/unknown model', () => {
    const counts = tokens({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000
    })
    // 5 + 25 + 5*1.25 + 5*0.1 = 36.75
    expect(estimateCostUsd(null, counts)).toBeCloseTo(36.75, 10)
    expect(estimateCostUsd(undefined, counts)).toBeCloseTo(36.75, 10)
    expect(estimateCostUsd('totally-unknown-model', counts)).toBeCloseTo(36.75, 10)
  })

  it('returns 0 for all-zero token counts', () => {
    expect(estimateCostUsd('claude-opus-4-6', tokens())).toBe(0)
  })
})
