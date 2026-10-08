import { createLocalDeviceSession } from './local-device'

let session: ReturnType<typeof createLocalDeviceSession> | undefined

/** Called once after the app acquires its instance lock, before starting services. */
export function initializeLocalDevice(localDirectory: string, machineName: string): void {
  session = createLocalDeviceSession(localDirectory, machineName)
}

export function getLocalDeviceSession() {
  if (!session) throw new Error('Local device has not been initialized')
  return session
}
