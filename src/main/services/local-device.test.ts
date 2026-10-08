// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createLocalDeviceSession, replaceLocalDeviceRegistration } from './local-device'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clautime-device-'))
})
afterEach(() => {
  if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unexpected fixture directory')
  rmSync(root, { recursive: true, force: true })
})

it('retains the device and chosen name across launches but creates fresh writer epochs', () => {
  const localDirectory = join(root, 'computer-a')
  const first = createLocalDeviceSession(localDirectory, ' Desktop ')
  const saved = readFileSync(join(localDirectory, 'device-registration.json'), 'utf8')
  const second = createLocalDeviceSession(localDirectory, 'Changed OS hostname')
  expect(second.deviceId).toBe(first.deviceId)
  expect(second.machineName).toBe('Desktop')
  expect(second.writerEpochId).not.toBe(first.writerEpochId)
  expect(readFileSync(join(localDirectory, 'device-registration.json'), 'utf8')).toBe(saved)
  expect(JSON.parse(saved)).toEqual({
    version: 1,
    deviceId: first.deviceId,
    machineName: 'Desktop'
  })
})

it('registers independent devices outside the portable database', () => {
  const first = createLocalDeviceSession(join(root, 'computer-a'), 'Desktop')
  const second = createLocalDeviceSession(join(root, 'computer-b'), 'Laptop')
  expect(second.deviceId).not.toBe(first.deviceId)
  expect(second.writerEpochId).not.toBe(first.writerEpochId)
})

it('uses a fresh writer even if the entire local registration was cloned', () => {
  const first = createLocalDeviceSession(join(root, 'computer-a'), 'Desktop')
  createLocalDeviceSession(join(root, 'computer-b'), 'Laptop')
  copyFileSync(
    join(root, 'computer-a', 'device-registration.json'),
    join(root, 'computer-b', 'device-registration.json')
  )
  const clone = createLocalDeviceSession(join(root, 'computer-b'), 'Laptop')
  expect(clone.deviceId).toBe(first.deviceId)
  expect(clone.writerEpochId).not.toBe(first.writerEpochId)
  // Explicit new-machine setup replaces the copied registration, not the database IDs.
  const replacement = replaceLocalDeviceRegistration(
    join(root, 'computer-b'),
    clone.deviceId,
    'Laptop'
  )
  expect(replacement.deviceId).not.toBe(first.deviceId)
  expect(replacement.machineName).toBe('Laptop')
  expect(createLocalDeviceSession(join(root, 'computer-b'), 'Ignored').deviceId).toBe(
    replacement.deviceId
  )
  expect(createLocalDeviceSession(join(root, 'computer-a'), 'Ignored').deviceId).toBe(
    first.deviceId
  )
  expect(readdirSync(join(root, 'computer-b'))).toEqual(['device-registration.json'])
})

it('refuses stale replacement requests without modifying the registration', () => {
  const first = createLocalDeviceSession(root, 'Desktop')
  const second = replaceLocalDeviceRegistration(root, first.deviceId, 'Restored desktop')
  const saved = readFileSync(join(root, 'device-registration.json'), 'utf8')
  expect(() => replaceLocalDeviceRegistration(root, first.deviceId, 'Stale setup')).toThrow(
    'Device registration changed'
  )
  expect(readFileSync(join(root, 'device-registration.json'), 'utf8')).toBe(saved)
  expect(createLocalDeviceSession(root, 'Ignored').deviceId).toBe(second.deviceId)
})

it('does not silently replace corrupt, incomplete or unsupported registration files', () => {
  for (const contents of [
    '',
    '{',
    'null',
    '{}',
    JSON.stringify({ version: 2, deviceId: 'future-format', machineName: 'Desktop' }),
    JSON.stringify({ version: 1, deviceId: 'not-a-uuid', machineName: 'Desktop' }),
    JSON.stringify({
      version: 1,
      deviceId: 'b612193b-091a-4b6c-95e2-e8ce62de46d0',
      machineName: ''
    })
  ]) {
    writeFileSync(join(root, 'device-registration.json'), contents)
    expect(() => createLocalDeviceSession(root, 'Desktop')).toThrow('Device registration')
    expect(readFileSync(join(root, 'device-registration.json'), 'utf8')).toBe(contents)
  }
})

it('rejects invalid names and relative local directories before creating files', () => {
  expect(() => createLocalDeviceSession('relative-device-fixture', 'Desktop')).toThrow('absolute')
  for (const name of ['', '   ', 'bad\0name']) {
    expect(() => createLocalDeviceSession(root, name)).toThrow('computer name')
  }
  expect(readdirSync(root)).toEqual([])
  const first = createLocalDeviceSession(root, 'Desktop')
  expect(() => replaceLocalDeviceRegistration(root, first.deviceId, '')).toThrow('computer name')
  expect(createLocalDeviceSession(root, 'Ignored').deviceId).toBe(first.deviceId)
})
