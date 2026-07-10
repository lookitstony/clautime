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

/**
 * Widget mode (#widget/<id>): the whole widget acts as its drag handle, like
 * the frameless Electron window it mimics. Pointer drags anywhere except on
 * buttons stream screen-space deltas to the parent page, which moves this
 * iframe under the cursor.
 */
function enableWidgetDrag(): void {
  const projectId = parseInt(window.location.hash.replace('#widget/', ''), 10)
  let dragging = false
  let lastX = 0
  let lastY = 0

  const style = document.createElement('style')
  style.textContent =
    'body { cursor: grab; user-select: none; -webkit-user-select: none; } body:active { cursor: grabbing; } button { cursor: pointer; }'
  document.head.appendChild(style)

  document.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    dragging = true
    lastX = e.screenX
    lastY = e.screenY
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  })
  document.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const dx = e.screenX - lastX
    const dy = e.screenY - lastY
    lastX = e.screenX
    lastY = e.screenY
    if (dx || dy) {
      window.parent.postMessage({ type: 'clautime-demo-widget', action: 'drag-by', projectId, dx, dy }, '*')
    }
  })
  const endDrag = (): void => {
    dragging = false
  }
  document.addEventListener('pointerup', endDrag)
  document.addEventListener('pointercancel', endDrag)
}

if (window.location.hash.startsWith('#widget/')) {
  enableWidgetDrag()
} else {
  addDemoBadge()
}

// Dynamic import so the mock api is in place before any app module evaluates.
void import('../main')
