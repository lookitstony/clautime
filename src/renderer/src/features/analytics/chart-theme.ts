import { useSyncExternalStore } from 'react'

function getThemeSnapshot(): string {
  const el = document.documentElement
  return `${el.getAttribute('data-theme') ?? ''}_${el.getAttribute('data-accent') ?? ''}`
}

let listeners: (() => void)[] = []
let observer: MutationObserver | null = null

function subscribe(listener: () => void): () => void {
  if (listeners.length === 0) {
    observer = new MutationObserver(() => {
      listeners.forEach((l) => l())
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent']
    })
  }
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((l) => l !== listener)
    if (listeners.length === 0) {
      observer?.disconnect()
      observer = null
    }
  }
}

function isDarkTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') !== 'light'
}

function readCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const HUES = [210, 160, 30, 340, 270, 120, 60, 190, 300, 90]

function buildPalette(dark: boolean): string[] {
  const lightness = dark ? 60 : 45
  return HUES.map((h) => `hsl(${h}, 55%, ${lightness}%)`)
}

export interface ChartColors {
  accent: string
  textColor: string
  mutedColor: string
  gridColor: string
  bgColor: string
  palette: string[]
}

export function useChartColors(): ChartColors {
  useSyncExternalStore(subscribe, getThemeSnapshot, getThemeSnapshot)

  const dark = isDarkTheme()
  return {
    accent: readCssVar('--accent') || (dark ? 'hsl(210, 55%, 60%)' : 'hsl(210, 55%, 45%)'),
    textColor: readCssVar('--text-primary') || (dark ? '#e4e4e7' : '#18181b'),
    mutedColor: readCssVar('--text-muted') || (dark ? '#71717a' : '#a1a1aa'),
    gridColor: readCssVar('--surface-border') || (dark ? '#27272a' : '#e4e4e7'),
    bgColor: readCssVar('--background-elevated') || (dark ? '#27272a' : '#f4f4f5'),
    palette: buildPalette(dark)
  }
}
