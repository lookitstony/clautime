// Launches the unpacked production build produced by `electron-builder --dir`.
// Run via `npm run app` (which builds first). No installer, no GitHub — just
// the compiled app from dist/<platform>-unpacked/.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

// electron-builder --dir output locations per platform (productName: ClauTime,
// win/linux executableName resolves to ClauTime/clautime).
const candidates = {
  win32: ['dist/win-unpacked/ClauTime.exe'],
  darwin: [
    'dist/mac-arm64/ClauTime.app/Contents/MacOS/ClauTime',
    'dist/mac/ClauTime.app/Contents/MacOS/ClauTime'
  ],
  linux: ['dist/linux-unpacked/clautime']
}

const list = candidates[process.platform] ?? []
const exe = list.map((p) => path.join(root, p)).find(existsSync)

if (!exe) {
  console.error('Built app not found. Looked for:')
  for (const p of list) console.error('  ', path.join(root, p))
  console.error('Run `npm run build:unpack` first.')
  process.exit(1)
}

console.log('Launching', exe)
const child = spawn(exe, [], { detached: true, stdio: 'ignore' })
child.unref()
