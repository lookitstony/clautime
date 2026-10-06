import {
  describeSourceMachines,
  type SessionSourceMachine
} from '../../../../shared/types/source-machine'

/** Row/detail text; an empty list means the original machine was never recorded. */
export function sourceMachineText(machines: readonly SessionSourceMachine[]): string {
  return machines.length ? describeSourceMachines(machines) : 'Origin not recorded'
}
