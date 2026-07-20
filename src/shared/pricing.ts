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
  { prefix: 'claude-3-opus', pricing: { displayName: 'Opus', inputPerMTok: 5, outputPerMTok: 25 } },
  // OpenAI models (Codex CLI sessions). Cached input bills at 0.1x, matching
  // CACHE_READ_MULTIPLIER; OpenAI has no cache-write charge and Codex logs never
  // report cacheCreation tokens, so the write multiplier is moot for these.
  { prefix: 'gpt-5.1-codex', pricing: { displayName: 'GPT-5.1 Codex', inputPerMTok: 1.25, outputPerMTok: 10 } },
  { prefix: 'gpt-5-codex', pricing: { displayName: 'GPT-5 Codex', inputPerMTok: 1.25, outputPerMTok: 10 } },
  { prefix: 'gpt-5.1-mini', pricing: { displayName: 'GPT-5.1 mini', inputPerMTok: 0.25, outputPerMTok: 2 } },
  { prefix: 'gpt-5-mini', pricing: { displayName: 'GPT-5 mini', inputPerMTok: 0.25, outputPerMTok: 2 } },
  { prefix: 'gpt-5-nano', pricing: { displayName: 'GPT-5 nano', inputPerMTok: 0.05, outputPerMTok: 0.4 } },
  { prefix: 'gpt-5.5', pricing: { displayName: 'GPT-5.5', inputPerMTok: 1.25, outputPerMTok: 10 } },
  { prefix: 'gpt-5.1', pricing: { displayName: 'GPT-5.1', inputPerMTok: 1.25, outputPerMTok: 10 } },
  { prefix: 'gpt-5', pricing: { displayName: 'GPT-5', inputPerMTok: 1.25, outputPerMTok: 10 } },
  // Older OpenAI models (OpenCode can route to any provider/model). More
  // specific variants first — 'gpt-4o' and 'gpt-4-turbo' before the bare 'gpt-4'
  // catch-all, and the nano/mini variants before their base model.
  { prefix: 'gpt-4.1-nano', pricing: { displayName: 'GPT-4.1 nano', inputPerMTok: 0.1, outputPerMTok: 0.4 } },
  { prefix: 'gpt-4.1-mini', pricing: { displayName: 'GPT-4.1 mini', inputPerMTok: 0.4, outputPerMTok: 1.6 } },
  { prefix: 'gpt-4.1', pricing: { displayName: 'GPT-4.1', inputPerMTok: 2, outputPerMTok: 8 } },
  { prefix: 'gpt-4o-mini', pricing: { displayName: 'GPT-4o mini', inputPerMTok: 0.15, outputPerMTok: 0.6 } },
  { prefix: 'gpt-4o', pricing: { displayName: 'GPT-4o', inputPerMTok: 2.5, outputPerMTok: 10 } },
  { prefix: 'gpt-4-turbo', pricing: { displayName: 'GPT-4 Turbo', inputPerMTok: 10, outputPerMTok: 30 } },
  { prefix: 'gpt-4', pricing: { displayName: 'GPT-4', inputPerMTok: 30, outputPerMTok: 60 } },
  // Google Gemini models (Gemini CLI sessions). Cached input bills at 0.1x via
  // CACHE_READ_MULTIPLIER. More specific variants first: flash-lite before
  // flash, and the bare 'gemini' catch-all last so it never shadows them.
  { prefix: 'gemini-2.5-flash-lite', pricing: { displayName: 'Gemini 2.5 Flash-Lite', inputPerMTok: 0.1, outputPerMTok: 0.4 } },
  { prefix: 'gemini-2.5-flash', pricing: { displayName: 'Gemini 2.5 Flash', inputPerMTok: 0.3, outputPerMTok: 2.5 } },
  { prefix: 'gemini-2.5-pro', pricing: { displayName: 'Gemini 2.5 Pro', inputPerMTok: 1.25, outputPerMTok: 10 } },
  { prefix: 'gemini-2.0-flash-lite', pricing: { displayName: 'Gemini 2.0 Flash-Lite', inputPerMTok: 0.075, outputPerMTok: 0.3 } },
  { prefix: 'gemini-2.0-flash', pricing: { displayName: 'Gemini 2.0 Flash', inputPerMTok: 0.1, outputPerMTok: 0.4 } },
  { prefix: 'gemini-1.5-flash', pricing: { displayName: 'Gemini 1.5 Flash', inputPerMTok: 0.075, outputPerMTok: 0.3 } },
  { prefix: 'gemini-1.5-pro', pricing: { displayName: 'Gemini 1.5 Pro', inputPerMTok: 1.25, outputPerMTok: 5 } },
  { prefix: 'gemini-3-pro', pricing: { displayName: 'Gemini 3 Pro', inputPerMTok: 2, outputPerMTok: 12 } },
  { prefix: 'gemini-3', pricing: { displayName: 'Gemini 3', inputPerMTok: 2, outputPerMTok: 12 } },
  { prefix: 'gemini', pricing: { displayName: 'Gemini', inputPerMTok: 1.25, outputPerMTok: 10 } }
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
