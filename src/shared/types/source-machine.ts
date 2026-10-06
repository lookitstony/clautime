import type { IpcResult } from './ipc'

/**
 * Source Machine provenance (folder-sync-plan.md decisions B, F and H). A machine is identified
 * only by its permanent device UUID; names are display labels. Provenance lists the computers
 * that observed or imported a record and never assigns ownership of its time.
 */

/** original: registration name; shared: agreed synced label; conflict: concurrent labels. */
export type SourceMachineLabelBasis = 'original' | 'shared' | 'conflict'

/** Revision heads per label field; pass back unchanged as the rename's observed heads. */
export type SourceMachineLabelHeads = Record<string, string[]>

export interface SourceMachineSummary {
  deviceId: string
  /** Agreed shared label, else the original name (also shown while labels conflict). */
  label: string
  /** Immutable name recorded when the device first registered. */
  originalName: string
  labelBasis: SourceMachineLabelBasis
  /** Conflicting shared labels, sorted by revision ID; empty unless labelBasis is conflict. */
  alternatives: string[]
  labelHeads: SourceMachineLabelHeads
  /** Another machine shows the same label; tell them apart by device ID. */
  duplicateLabel: boolean
  isThisComputer: boolean
}

/**
 * observed: this machine captured the record itself.
 * imported: history that existed before provenance; the machine imported it, origin unknown.
 */
export type SourceMachineBasis = 'observed' | 'imported'

export interface SessionSourceMachine {
  deviceId: string
  label: string
  basis: SourceMachineBasis
}

export interface RenameSourceMachineInput {
  deviceId: string
  name: string
  /** labelHeads from the summary the user edited; unseen concurrent labels become a conflict. */
  observedHeads: SourceMachineLabelHeads
}

export const SOURCE_MACHINE_CHANNELS = {
  list: 'machine:list',
  rename: 'machine:rename'
} as const

/** Preload surface (window.api.machines); wired by the root preload. */
export interface SourceMachineCoverage extends SourceMachineSummary {
  latestActivityAt: string | null
  lastReceivedAt: string | null
}

export interface SourceMachineApi {
  coverage(): Promise<IpcResult<SourceMachineCoverage[]>>
  list(): Promise<IpcResult<SourceMachineSummary[]>>
  rename(input: RenameSourceMachineInput): Promise<IpcResult<SourceMachineSummary>>
}

/** Short provenance text for a session row, e.g. "Desk", "Desk, Laptop", "Imported from Desk". */
export function describeSourceMachines(machines: readonly SessionSourceMachine[]): string {
  // One entry per device, so two machines sharing a label both stay visible.
  const labels = (basis: SourceMachineBasis): string[] => {
    const byDevice = new Map<string, string>()
    for (const m of machines) if (m.basis === basis) byDevice.set(m.deviceId, m.label)
    return [...byDevice.values()]
  }
  const observed = labels('observed')
  const imported = labels('imported')
  const parts: string[] = []
  if (observed.length) parts.push(observed.join(', '))
  if (imported.length) parts.push(`Imported from ${imported.join(', ')}`)
  return parts.join('; ')
}
