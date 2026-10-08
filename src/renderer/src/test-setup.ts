import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

// Tests never read or create the installed app's device registration.
vi.mock('../../main/services/device-context', () => ({
  getLocalDeviceSession: () => ({
    version: 1,
    deviceId: '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222',
    machineName: 'Fixture computer',
    writerEpochId: 'a6a69b8a-e0f3-47da-94b9-606c9365a201'
  })
}))
