/**
 * Claude API pricing for hypothetical cost estimation.
 * Rates are USD per million tokens (MTok), as published on platform.claude.com.
 * Cache reads bill at 0.1x the input rate; cache writes at 1.25x (5-minute TTL,
 * which is what Claude Code uses).
 *
 * Rates as of 2026-06. Update here when Anthropic changes pricing.
 */

export interface ModelPricing {
  /** Display name for the model family */
  displayName: string
  /** USD per 1M input tokens */
  inputPerMTok: number
  /** USD per 1M output tokens */
  outputPerMTok: number
}

const CACHE_WRITE_MULTIPLIER = 1.25
const CACHE_READ_MULTIPLIER = 0.1

/** Ordered prefix-match table — first match wins. */
const PRICING_TABLE: { prefix: string; pricing: ModelPricing }[] = [
  { prefix: 'claude-fable-5', pricing: { displayName: 'Fable 5', inputPerMTok: 10, outputPerMTok: 50 } },
  { prefix: 'claude-mythos-5', pricing: { displayName: 'Mythos 5', inputPerMTok: 10, outputPerMTok: 50 } },
  { prefix: 'claude-opus', pricing: { displayName: 'Opus', inputPerMTok: 5, outputPerMTok: 25 } },
  { prefix: 'claude-sonnet', pricing: { displayName: 'Sonnet', inputPerMTok: 3, outputPerMTok: 15 } },
  { prefix: 'claude-haiku', pricing: { displayName: 'Haiku', inputPerMTok: 1, outputPerMTok: 5 } },
  // Older naming convention: claude-3-5-haiku-..., claude-3-opus-...
  { prefix: 'claude-3-5-haiku', pricing: { displayName: 'Haiku', inputPerMTok: 1, outputPerMTok: 5 } },
  { prefix: 'claude-3-haiku', pricing: { displayName: 'Haiku', inputPerMTok: 1, outputPerMTok: 5 } },
  { prefix: 'claude-3-5-sonnet', pricing: { displayName: 'Sonnet', inputPerMTok: 3, outputPerMTok: 15 } },
  { prefix: 'claude-3-sonnet', pricing: { displayName: 'Sonnet', inputPerMTok: 3, outputPerMTok: 15 } },
  { prefix: 'claude-3-opus', pricing: { displayName: 'Opus', inputPerMTok: 5, outputPerMTok: 25 } }
]

/** Fallback for unknown or missing model strings — Opus rates, since this app's usage is mostly Opus. */
const FALLBACK_PRICING: ModelPricing = { displayName: 'Unknown (Opus rates)', inputPerMTok: 5, outputPerMTok: 25 }

export function getModelPricing(model: string | null | undefined): ModelPricing {
  if (model) {
    for (const entry of PRICING_TABLE) {
      if (model.startsWith(entry.prefix)) return entry.pricing
    }
  }
  return FALLBACK_PRICING
}

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

/** Estimated API cost in USD for the given token counts on the given model. */
export function estimateCostUsd(model: string | null | undefined, tokens: TokenCounts): number {
  const p = getModelPricing(model)
  const perTokIn = p.inputPerMTok / 1_000_000
  const perTokOut = p.outputPerMTok / 1_000_000
  return (
    tokens.inputTokens * perTokIn +
    tokens.outputTokens * perTokOut +
    tokens.cacheCreationInputTokens * perTokIn * CACHE_WRITE_MULTIPLIER +
    tokens.cacheReadInputTokens * perTokIn * CACHE_READ_MULTIPLIER
  )
}
