/**
 * Entry point for the browser demo (docs/demo). Installs the mock window.api
 * BEFORE the app modules load, then boots the real renderer unchanged.
 */
import { installMockApi } from './mock-api'

installMockApi()

function addDemoBadge(): void {
  const badge = document.createElement('a')
  badge.href = 'https://github.com/lookitstony/clautime'
  badge.target = '_blank'
  badge.rel = 'noopener'
  badge.textContent = 'DEMO · sample data — get the app'
  badge.style.cssText = [
    'position:fixed',
    'bottom:34px',
    'right:12px',
    'z-index:99999',
    'font-family:ui-monospace,monospace',
    'font-size:11px',
    'letter-spacing:0.04em',
    'padding:5px 12px',
    'border-radius:999px',
    'background:#0d1117e6',
    'color:#2dd4bf',
    'border:1px solid #2dd4bf55',
    'text-decoration:none',
    'backdrop-filter:blur(6px)',
    'box-shadow:0 4px 16px #00000066'
  ].join(';')
  document.body.appendChild(badge)
}

addDemoBadge()

// Dynamic import so the mock api is in place before any app module evaluates.
void import('../main')
