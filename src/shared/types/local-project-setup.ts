export interface LegacyFolderSelection {
  projectSyncId: string
  directoryPath: string
}

export interface LocalProjectSetupStatus {
  machineName: string
  complete: boolean
  candidates: (LegacyFolderSelection & { projectName: string })[]
}
