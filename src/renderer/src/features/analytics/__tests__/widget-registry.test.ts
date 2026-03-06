import { describe, it, expect } from 'vitest'
import { WIDGET_REGISTRY, DEFAULT_LAYOUT, SIZE_CONFIG } from '../widget-registry'

describe('widget-registry', () => {
  it('has 8 widgets registered', () => {
    expect(WIDGET_REGISTRY).toHaveLength(8)
  })

  it('each widget has required fields', () => {
    for (const widget of WIDGET_REGISTRY) {
      expect(widget.id).toBeTruthy()
      expect(widget.title).toBeTruthy()
      expect(widget.icon).toBeDefined()
      expect(widget.component).toBeDefined()
      expect(widget.defaultSize).toBeTruthy()
      expect(['small', 'medium', 'large']).toContain(widget.defaultSize)
    }
  })

  it('widget IDs are unique', () => {
    const ids = WIDGET_REGISTRY.map((w) => w.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('DEFAULT_LAYOUT includes all 8 widgets', () => {
    expect(DEFAULT_LAYOUT.widgets).toHaveLength(8)
    const ids = DEFAULT_LAYOUT.widgets.map((w) => w.id)
    for (const widget of WIDGET_REGISTRY) {
      expect(ids).toContain(widget.id)
    }
  })

  it('SIZE_CONFIG has correct colSpan values', () => {
    expect(SIZE_CONFIG.small.colSpan).toBe(1)
    expect(SIZE_CONFIG.medium.colSpan).toBe(1)
    expect(SIZE_CONFIG.large.colSpan).toBe(2)
  })

  it('SIZE_CONFIG has increasing heights', () => {
    expect(SIZE_CONFIG.small.height).toBeLessThan(SIZE_CONFIG.medium.height)
    expect(SIZE_CONFIG.medium.height).toBeLessThan(SIZE_CONFIG.large.height)
  })
})
