// Terminates any running unpacked-build instance so `electron-builder --dir`
// can overwrite dist/<platform>-unpacked/ (a running exe locks the file).
// Safe to run when nothing is running — failures are ignored.
import { spawnSync } from 'node:child_process'

const cmds = {
  win32: ['taskkill', ['/F', '/IM', 'ClauTime.exe']],
  darwin: ['pkill', ['-f', 'ClauTime.app']],
  linux: ['pkill', ['-f', 'clautime']]
}

const entry = cmds[process.platform]
if (entry) {
  const [cmd, args] = entry
  spawnSync(cmd, args, { stdio: 'ignore' })
}
