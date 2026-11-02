// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { extractTicketId } from './ticket-id'

describe('extractTicketId', () => {
  it('reads a ticket that leads the message, followed by a colon or space', () => {
    expect(extractTicketId('TRI3-4856: Record the agent license number')).toBe('TRI3-4856')
    expect(extractTicketId('SOL-4216 Fix the quote total')).toBe('SOL-4216')
    expect(extractTicketId('proj-12: lowercase key')).toBe('PROJ-12')
    expect(extractTicketId('#456 Fix crash')).toBe('#456')
  })

  it('ignores tickets that are not at the start of the message', () => {
    expect(extractTicketId('Fix registration tests, enable MTL-004')).toBeNull()
    expect(extractTicketId('Unskip MP-008: free user PDF download')).toBeNull()
  })

  it('ignores hyphenated words and non-numeric suffixes', () => {
    expect(extractTicketId('Auto-detect projects')).toBeNull()
    expect(extractTicketId('Sign-in: keep session')).toBeNull()
    expect(extractTicketId('model-3d skill: A-pose concept rule')).toBeNull()
    expect(extractTicketId('5-step wizard')).toBeNull()
  })

  it('requires a colon or space after the ID and skips spec tokens', () => {
    expect(extractTicketId('TRI-12a: suffix letters')).toBeNull()
    expect(extractTicketId('TRI-12')).toBeNull()
    expect(extractTicketId('UTF-8 handling')).toBeNull()
    expect(extractTicketId('x86-64 build')).toBeNull()
  })
})
