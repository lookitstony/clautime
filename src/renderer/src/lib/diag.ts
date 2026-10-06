// [DIAG] Temporary renderer instrumentation to hunt UI freezes (white title
// bar while idle). Reports event-loop lag, long tasks and heap growth to the
// main-process log file. Remove together with the [DIAG] block in
// src/main/index.ts once the freeze source is found.
import log from 'electron-log/renderer'

const surface = window.location.hash.startsWith('#widget/') ? 'widget' : 'main'

let lastTick = Date.now()
setInterval(() => {
  const now = Date.now()
  const lag = now - lastTick - 1000
  if (lag > 500) log.warn(`[DIAG] renderer(${surface}) event loop stalled ~${lag}ms`)
  lastTick = now
}, 1000)

if (typeof PerformanceObserver !== 'undefined') {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 500) {
          log.warn(`[DIAG] renderer(${surface}) long task ${Math.round(entry.duration)}ms`)
        }
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    // longtask entries unsupported — lag watchdog above still covers stalls
  }
}

const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
if (memory) {
  setInterval(() => {
    log.info(`[DIAG] renderer(${surface}) heap ${Math.round(memory.usedJSHeapSize / 1048576)}MB`)
  }, 60_000)
}
