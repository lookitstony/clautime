/** Default AI summary instructions. Users can customize this in Settings. */
export const DEFAULT_AI_SUMMARY_INSTRUCTIONS = `If any commit messages contain work item numbers, ticket IDs, or issue references (e.g. JIRA-123, #456, FEAT-789, BUG-101):
- Preserve them in the summary
- Format each bullet with the ticket ID first: "TICKET-123: description of work done"
- Group related commits under the same ticket ID when possible
Focus on what was built, fixed, or improved.
Do not include commit hashes, timestamps, or a top-level title/header.
Start directly with the ## section headers — do NOT add a # title line.`

/** Default AI brief summary instructions. Users can customize this in Settings. */
export const DEFAULT_AI_BRIEF_INSTRUCTIONS = `The reader is a non-technical business owner reviewing a timesheet to understand what they are paying for.
Use plain, non-technical language. Describe work in terms of business outcomes and features — NOT implementation details, code changes, or technical jargon.
Frame accomplishments so the reader feels confident their investment is delivering tangible value.
For example: "Fixed bug preventing users from logging in" NOT "Resolved null pointer exception in auth middleware".
Preserve ticket IDs when present (e.g. TRI-1685) but describe the work in plain language.`
