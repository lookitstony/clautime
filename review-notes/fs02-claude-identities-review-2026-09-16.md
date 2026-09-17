# Claude activity identities: code review

Status: **P2 fixed locally.** Fallback inputs now include a nonempty provider `message.id`. Fingerprints without a provider message ID and native UUID identities retain their existing encoding. Two permanent parser fixtures reproduced the collision before the fix and now pass for main/subagent records; they also verify stable usage/model corrections and distinct content blocks within one provider response. **64 tests across identity, parser and retention suites**, both typechecks, targeted lint, formatting and whitespace checks pass. No migration, live change, commit or push.

Scope: the new Claude identity helper, its parser integration and fixtures. Existing persistence/deduplication is intentionally outside this slice.

## Finding

**P2 (fixed): Preserve provider message IDs in the fallback fingerprint.** At review time, the fallback projection in `src/main/parsers/claude-activity-identity.ts` included role/content but omitted `message.id`. With an unavailable outer UUID, two assistant records with the same conversation, predecessor, timestamp and content but different provider message IDs received the same `eventId`. The original records contained evidence that they were distinct, but parsing discarded it. The fix includes the provider message ID in the fallback input without treating usage/model corrections as new events. Local totals were unaffected because this field is not consumed yet.

A focused fixture with `msg_first_response` versus `msg_second_response` fails the distinct-key assertion. The reproduction is archived in `fs02-claude-identity-review-repro-2026-09-16.ts.txt`; its temporary source test was removed after verification.

## Verification

- Existing identity/parser suites: **45 tests passed**.
- Focused collision fixture: **1 failed** as described above.
- No implementation fix, live data change, commit or push was made during review.

No other actionable finding was confirmed in this slice. Other-provider adapters, persistence, complete branch reconstruction and ledger consumption remain explicitly unfinished FS02 work.
