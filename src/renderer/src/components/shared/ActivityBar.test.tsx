import { describe, it, expect } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ActivityBar } from './ActivityBar'

function renderWithRouter(initialPath = '/') {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <TooltipProvider delayDuration={0}>
            <ActivityBar />
          </TooltipProvider>
        ),
        children: [
          { index: true, element: <div>Live</div> },
          { path: 'sessions', element: <div>Sessions</div> },
          { path: 'reports', element: <div>Reports</div> },
          { path: 'analytics', element: <div>Analytics</div> },
          { path: 'clients', element: <div>Clients</div> },
          { path: 'settings', element: <div>Settings</div> }
        ]
      }
    ],
    { initialEntries: [initialPath] }
  )
  return { ...render(<RouterProvider router={router} />), router }
}

describe('ActivityBar', () => {
  it('renders navigation with correct aria attributes', () => {
    renderWithRouter()
    const nav = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(nav).toBeInTheDocument()
  })

  it('renders all 6 navigation buttons', () => {
    renderWithRouter()
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(6)
  })

  it('renders buttons with correct labels', () => {
    renderWithRouter()
    expect(screen.getByLabelText('Sessions')).toBeInTheDocument()
    expect(screen.getByLabelText('Live')).toBeInTheDocument()
    expect(screen.getByLabelText('Reports')).toBeInTheDocument()
    expect(screen.getByLabelText('Analytics')).toBeInTheDocument()
    expect(screen.getByLabelText('Clients')).toBeInTheDocument()
    expect(screen.getByLabelText('Settings')).toBeInTheDocument()
  })

  it('marks Live as active on index route', () => {
    renderWithRouter('/')
    const liveButton = screen.getByLabelText('Live')
    expect(liveButton).toHaveAttribute('aria-current', 'page')
  })

  it('navigates when clicking an icon', async () => {
    const user = userEvent.setup()
    const { router } = renderWithRouter('/')
    await user.click(screen.getByLabelText('Sessions'))
    expect(router.state.location.pathname).toBe('/sessions')
  })

  it('supports keyboard navigation with arrow keys', async () => {
    const user = userEvent.setup()
    renderWithRouter('/')
    const sessionsBtn = screen.getByLabelText('Sessions')
    await act(async () => sessionsBtn.focus())
    await user.keyboard('{ArrowDown}')
    expect(screen.getByLabelText('Live')).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByLabelText('Reports')).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByLabelText('Analytics')).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByLabelText('Reports')).toHaveFocus()
  })

  it('wraps keyboard navigation at boundaries', async () => {
    const user = userEvent.setup()
    renderWithRouter('/')
    const sessionsBtn = screen.getByLabelText('Sessions')
    await act(async () => sessionsBtn.focus())
    await user.keyboard('{ArrowUp}')
    expect(screen.getByLabelText('Settings')).toHaveFocus()
  })
})
