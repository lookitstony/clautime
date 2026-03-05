/** Client row shape matching the clients table schema. */
export interface Client {
  id: number
  name: string
  color: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** Data for creating a new client. */
export interface NewClient {
  name: string
  /** CSS variable reference, e.g. 'var(--project-1)'. Auto-assigned if omitted. */
  color?: string
}

/** Data for updating an existing client. All fields optional. */
export interface UpdateClient {
  name?: string
  color?: string
  isActive?: boolean
}

/** Project row shape matching the projects table schema. */
export interface Project {
  id: number
  clientId: number
  name: string
  directoryPath: string
  isBillable: boolean
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** Data for creating a new project. */
export interface NewProject {
  clientId: number
  name: string
  directoryPath: string
  /** Defaults to true if omitted. */
  isBillable?: boolean
}

/** Data for updating an existing project. All fields optional. */
export interface UpdateProject {
  name?: string
  directoryPath?: string
  isBillable?: boolean
  isActive?: boolean
  clientId?: number
}

/** The 8 fixed project colors for visual identification. */
export const CLIENT_COLORS = [
  'var(--project-1)',
  'var(--project-2)',
  'var(--project-3)',
  'var(--project-4)',
  'var(--project-5)',
  'var(--project-6)',
  'var(--project-7)',
  'var(--project-8)'
] as const
