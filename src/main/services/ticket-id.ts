// Common technical-spec tokens shaped like tickets (UTF-8, ISO-8859, COVID-19,
// HTTP-2, etc.) but never actual issue keys. Excluded from ticket extraction.
const NON_TICKET_PREFIXES = new Set([
  'UTF',
  'ASCII',
  'ISO',
  'COVID',
  'HTTP',
  'HTTPS',
  'IPV',
  'TLS',
  'SSL',
  'AES',
  'RSA',
  'SHA',
  'MD',
  'RFC',
  'OAUTH',
  'JWT',
  'API',
  'REST',
  'JSON',
  'XML',
  'YAML',
  'CSV',
  'HTML',
  'CSS',
  'JS',
  'TS',
  'EOL',
  'X86'
])

/**
 * Extract the ticket/work item ID leading a commit message, or return null.
 * The ID must start the message and be followed by ":" or whitespace
 * (TRI3-4856: ..., proj-12 ..., #456 ...). Requiring only digits after the
 * dash keeps hyphenated words like "Auto-detect" or "model-3d" out.
 */
export function extractTicketId(message: string): string | null {
  const match = message.match(/^([A-Za-z0-9]+-\d+)(?=[:\s])/) ?? message.match(/^(#\d+)\b/)
  if (!match) return null
  const candidate = match[1].toUpperCase()
  const prefix = candidate.split('-')[0]
  if (NON_TICKET_PREFIXES.has(prefix)) return null
  return candidate
}
