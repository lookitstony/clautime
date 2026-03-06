import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WidgetPanel } from '../WidgetPanel'
import { DEFAULT_LAYOUT, WIDGET_REGISTRY } from '../widget-registry'

describe('WidgetPanel', () => {
  it('renders the Customize button', () => {
    render(<WidgetPanel layout={DEFAULT_LAYOUT} onToggle={vi.fn()} />)
    expect(screen.getByText('Customize')).toBeInTheDocument()
  })

  it('shows all widgets when popover is opened', async () => {
    const user = userEvent.setup()
    render(<WidgetPanel layout={DEFAULT_LAYOUT} onToggle={vi.fn()} />)

    await user.click(screen.getByText('Customize'))

    for (const widget of WIDGET_REGISTRY) {
      expect(screen.getByText(widget.title)).toBeInTheDocument()
    }
  })

  it('calls onToggle with correct widget id when switch is clicked', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(<WidgetPanel layout={DEFAULT_LAYOUT} onToggle={onToggle} />)

    await user.click(screen.getByText('Customize'))

    const dailyHoursSwitch = screen.getByRole('switch', { name: 'Toggle Daily Hours' })
    await user.click(dailyHoursSwitch)

    expect(onToggle).toHaveBeenCalledWith('daily-hours')
  })

  it('shows switches as checked for active widgets', async () => {
    const user = userEvent.setup()
    render(<WidgetPanel layout={DEFAULT_LAYOUT} onToggle={vi.fn()} />)

    await user.click(screen.getByText('Customize'))

    const switches = screen.getAllByRole('switch')
    for (const sw of switches) {
      expect(sw).toHaveAttribute('data-state', 'checked')
    }
  })

  it('shows switch as unchecked for removed widgets', async () => {
    const user = userEvent.setup()
    const partialLayout = { widgets: [{ id: 'daily-hours', size: 'medium' as const }] }
    render(<WidgetPanel layout={partialLayout} onToggle={vi.fn()} />)

    await user.click(screen.getByText('Customize'))

    const dailySwitch = screen.getByRole('switch', { name: 'Toggle Daily Hours' })
    expect(dailySwitch).toHaveAttribute('data-state', 'checked')

    const tokenSwitch = screen.getByRole('switch', { name: 'Toggle Token Usage' })
    expect(tokenSwitch).toHaveAttribute('data-state', 'unchecked')
  })
})
