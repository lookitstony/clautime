// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { ipcSuccess, ipcError, AppError } from './ipc'

describe('IpcResult helpers', () => {
  it('creates success result', () => {
    const result = ipcSuccess('hello')
    expect(result).toEqual({ success: true, data: 'hello' })
  })

  it('creates error result', () => {
    const result = ipcError('NOT_FOUND', 'Setting not found')
    expect(result).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Setting not found' }
    })
  })
})

describe('AppError', () => {
  it('creates error with code and message', () => {
    const err = new AppError('DB_ERROR', 'Connection failed')
    expect(err.code).toBe('DB_ERROR')
    expect(err.message).toBe('Connection failed')
    expect(err.name).toBe('AppError')
    expect(err).toBeInstanceOf(Error)
  })
})
