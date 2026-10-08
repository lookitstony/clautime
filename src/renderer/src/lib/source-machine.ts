import type { SourceMachineSummary } from '../../../shared/types/source-machine'

/** Duplicate labels stay distinguishable by device ID; the ID itself is never editable here. */
export function sourceMachineOptionLabel(machine: SourceMachineSummary): string {
  const notes = [
    machine.isThisComputer ? 'this computer' : null,
    machine.duplicateLabel ? machine.deviceId.slice(0, 8) : null
  ].filter(Boolean)
  return notes.length ? `${machine.label} (${notes.join(', ')})` : machine.label
}
