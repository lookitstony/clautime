import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { AppError } from '../../shared/types/ipc'

interface DeviceRegistration {
  version: 1
  deviceId: string
  machineName: string
}

function registrationPath(localDirectory: string): string {
  if (!isAbsolute(localDirectory)) {
    throw new AppError('INVALID_DEVICE_DIRECTORY', 'The local device directory must be absolute')
  }
  return join(localDirectory, 'device-registration.json')
}

function readRegistration(path: string): DeviceRegistration | null {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const value = JSON.parse(contents)
    if (
      value?.version !== 1 ||
      typeof value.deviceId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.deviceId) ||
      typeof value.machineName !== 'string' ||
      !value.machineName.trim() ||
      value.machineName.includes('\0')
    ) {
      throw new Error('Invalid registration')
    }
    return { version: 1, deviceId: value.deviceId, machineName: value.machineName }
  } catch {
    // Replacing a damaged/unknown file automatically would silently change provenance.
    throw new AppError(
      'INVALID_DEVICE_REGISTRATION',
      'Device registration is invalid or unsupported'
    )
  }
}

function newRegistration(machineName: string): DeviceRegistration {
  const name = machineName.trim()
  if (!name || name.includes('\0')) {
    throw new AppError('INVALID_MACHINE_NAME', 'A computer name is required')
  }
  return { version: 1, deviceId: randomUUID(), machineName: name }
}

/**
 * Call once per launch after acquiring the app instance lock. The directory must
 * be local app configuration, outside the portable DB and the selected sync folder.
 * A DB-only restore gets a new device; even a full configuration clone gets a new writer.
 */
export function createLocalDeviceSession(localDirectory: string, machineName: string) {
  const path = registrationPath(localDirectory)
  let registration = readRegistration(path)
  if (!registration) {
    registration = newRegistration(machineName)
    mkdirSync(localDirectory, { recursive: true })
    // Exclusive creation cannot overwrite a registration created by another process.
    // An interrupted write is rejected on the next launch, never silently regenerated.
    try {
      writeFileSync(path, JSON.stringify(registration) + '\n', { flag: 'wx', flush: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = readRegistration(path)
      if (!existing) throw error
      registration = existing
    }
  }
  return { ...registration, writerEpochId: randomUUID() }
}

/** Explicit new-machine/restore setup only; never invoke this just because a DB changed. */
export function replaceLocalDeviceRegistration(
  localDirectory: string,
  expectedDeviceId: string,
  machineName: string
): DeviceRegistration {
  const path = registrationPath(localDirectory)
  if (readRegistration(path)?.deviceId !== expectedDeviceId) {
    throw new AppError('DEVICE_REGISTRATION_CHANGED', 'Device registration changed; reopen setup')
  }
  const registration = newRegistration(machineName)
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(registration) + '\n', { flag: 'wx', flush: true })
  try {
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return registration
}
