import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Redacted } from './Redacted'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

/**
 * Stub the settings IPC so usePresentationMode resolves to the given state, and
 * return the mock so tests can wait for the setting to actually land — before it
 * resolves, the hook reports "off" and children render unwrapped.
 */
function stubPresentationMode(enabled: boolean): ReturnType<typeof vi.fn> {
  const getAll = vi
    .fn()
    .mockResolvedValue({ success: true, data: { presentation_mode: String(enabled) } })
  vi.stubGlobal('api', { settings: { getAll } })
  return getAll
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('Redacted', () => {
  it('renders children unwrapped when presentation mode is off', async () => {
    const getAll = stubPresentationMode(false)
    render(<Redacted>in_1PqRsTuVwXyZ</Redacted>, { wrapper: createWrapper() })
    await waitFor(() => expect(getAll).toHaveBeenCalled())
    // No blur wrapper — the text sits directly in the render container
    expect(screen.getByText('in_1PqRsTuVwXyZ').tagName).toBe('DIV')
  })

  it('wraps children in a blurred span when presentation mode is on', async () => {
    stubPresentationMode(true)
    render(<Redacted>in_1PqRsTuVwXyZ</Redacted>, { wrapper: createWrapper() })
    await waitFor(() => expect(screen.getByText('in_1PqRsTuVwXyZ').tagName).toBe('SPAN'))
    const span = screen.getByText('in_1PqRsTuVwXyZ')
    expect(span.className).toContain('blur-[5px]')
    expect(span.className).toContain('select-none')
  })

  it('merges an extra className onto the blurred span', async () => {
    stubPresentationMode(true)
    render(<Redacted className="w-40">secret memo</Redacted>, { wrapper: createWrapper() })
    await waitFor(() => expect(screen.getByText('secret memo').className).toContain('w-40'))
  })

  it('blurs on the first frame when the last known setting was on', () => {
    // Cold start: the settings query never resolves, so only the cached value can save us
    localStorage.setItem('presentation-mode', 'true')
    vi.stubGlobal('api', { settings: { getAll: vi.fn(() => new Promise(() => {})) } })
    render(<Redacted>secret memo</Redacted>, { wrapper: createWrapper() })
    expect(screen.getByText('secret memo').tagName).toBe('SPAN')
  })

  it('does not blur on the first frame when the last known setting was off', () => {
    localStorage.setItem('presentation-mode', 'false')
    vi.stubGlobal('api', { settings: { getAll: vi.fn(() => new Promise(() => {})) } })
    render(<Redacted>plain memo</Redacted>, { wrapper: createWrapper() })
    expect(screen.getByText('plain memo').tagName).toBe('DIV')
  })

  it('caches the resolved setting for the next cold start', async () => {
    stubPresentationMode(true)
    render(<Redacted>secret memo</Redacted>, { wrapper: createWrapper() })
    await waitFor(() => expect(localStorage.getItem('presentation-mode')).toBe('true'))
  })

  it('still renders the text content while blurred', async () => {
    stubPresentationMode(true)
    render(<Redacted>secret memo</Redacted>, { wrapper: createWrapper() })
    await waitFor(() => expect(screen.getByText('secret memo').tagName).toBe('SPAN'))
    expect(screen.getByText('secret memo')).toBeInTheDocument()
  })
})
