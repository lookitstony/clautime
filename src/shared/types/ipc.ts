/**
 * Typed IPC response wrapper — all IPC calls return this format.
 * Never throw raw exceptions across the IPC boundary.
 */
export type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } }

/** Create a success IpcResult */
export function ipcSuccess<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

/** Create an error IpcResult */
export function ipcError(code: string, message: string): IpcResult<never> {
  return { success: false, error: { code, message } }
}

/**
 * Structured application error with error code.
 * Used by services to throw typed errors that IPC handlers catch and wrap.
 */
export class AppError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'AppError'
  }
}
