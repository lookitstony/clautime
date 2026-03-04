import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBar } from './StatusBar'

describe('StatusBar', () => {
  it('renders default placeholder values', () => {
    render(<StatusBar />)
    expect(screen.getByText('Watching 0 projects')).toBeInTheDocument()
    expect(screen.getByText('Last scan: never')).toBeInTheDocument()
    expect(screen.getByText('0h 0m today')).toBeInTheDocument()
  })

  it('renders custom prop values', () => {
    render(<StatusBar watchCount={3} lastScan="2 min ago" dailyTotal="4h 32m" />)
    expect(screen.getByText('Watching 3 projects')).toBeInTheDocument()
    expect(screen.getByText('Last scan: 2 min ago')).toBeInTheDocument()
    expect(screen.getByText('4h 32m today')).toBeInTheDocument()
  })

  it('has footer role', () => {
    render(<StatusBar />)
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
  })
})
