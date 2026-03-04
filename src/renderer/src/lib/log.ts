// Renderer-side logging via electron-log
// Requires log.initialize() to have been called in the main process
// Uses IPC transport to send logs to main process file logger
import log from 'electron-log/renderer.js'

export default log
