/**
 * Fictional display aliases for Presentation Mode. When a client or project
 * has no stage name, these substitute a made-up (non-real-business) name
 * derived deterministically from the row id — display only, never persisted.
 * Ids past the end of a list wrap around with a numeric suffix ("Bluepine 2").
 */

const CLIENT_ALIASES = [
  'Bluepine Labs',
  'Kestrel & Finch',
  'Marlowe Digital',
  'Violet Harbor Co',
  'Quartzline Systems',
  'Fernwick Group',
  'Saltgrass Studio',
  'Ironvale Consulting',
  'Cindermoor LLC',
  'Willowmere Tech',
  'Bramblewood Inc',
  'Starkfield Analytics',
  'Ochre Point Media',
  'Silvermist Ventures',
  'Thornbury Collective',
  'Gladeview Solutions',
  'Emberlight Partners',
  'Foxglove Creative',
  'Windrose Systems',
  'Duskwater Labs'
]

const PROJECT_ALIASES = [
  'Falcon',
  'Bluebird',
  'Redwood',
  'Compass',
  'Lantern',
  'Orbit',
  'Summit',
  'Meadow',
  'Anchor',
  'Beacon',
  'Cascade',
  'Driftwood',
  'Emberfall',
  'Flintlock',
  'Juniper',
  'Nimbus',
  'Onyx',
  'Quill',
  'Sable',
  'Tundra',
  'Vesper',
  'Wren',
  'Zephyr',
  'Pebbleton'
]

function pick(list: string[], id: number): string {
  const idx = Math.abs(id - 1) % list.length
  const round = Math.floor(Math.abs(id - 1) / list.length)
  return round === 0 ? list[idx] : `${list[idx]} ${round + 1}`
}

export function clientAlias(id: number): string {
  return pick(CLIENT_ALIASES, id)
}

export function projectAlias(id: number): string {
  return pick(PROJECT_ALIASES, id)
}
