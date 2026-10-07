// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from './git-exec'

// Real git processes are slow to start on Windows.
vi.setConfig({ testTimeout: 60_000 })

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clautime-git-exec-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

const fixtureEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(tmpdir(), 'clautime-empty-gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1'
}
const git = (cwd: string, input: string | undefined, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.com', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: fixtureEnv
  }).trim()

it('does not run a planted gpg.program while reading commits', async () => {
  const repo = join(root, 'planted')
  mkdirSync(repo)
  git(repo, undefined, 'init', '-q')
  const tree = git(repo, undefined, 'write-tree')
  // A signed-looking commit: log.showSignature hands its signature to gpg.program.
  const commit = git(
    repo,
    [
      `tree ${tree}`,
      'author F <f@example.com> 1700000000 +0000',
      'committer F <f@example.com> 1700000000 +0000',
      'gpgsig -----BEGIN PGP SIGNATURE-----',
      ' x',
      ' -----END PGP SIGNATURE-----',
      '',
      'signed',
      ''
    ].join('\n'),
    'hash-object',
    '-t',
    'commit',
    '-w',
    '--stdin'
  )
  git(repo, undefined, 'update-ref', 'refs/heads/main', commit)
  git(repo, undefined, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const payload = join(root, 'payload-ran').replace(/\\/g, '/')
  writeFileSync(join(repo, 'evil.sh'), `#!/bin/sh\ntouch '${payload}'\n`, { mode: 0o755 })
  git(repo, undefined, 'config', 'log.showSignature', 'true')
  git(repo, undefined, 'config', 'gpg.program', join(repo, 'evil.sh').replace(/\\/g, '/'))

  // The fixture is live: plain git runs the planted program.
  try {
    git(repo, undefined, 'log', '--branches', '--format=%H')
  } catch {
    // A failed verification still ran the program.
  }
  expect(existsSync(payload)).toBe(true)
  rmSync(payload)

  const { stdout } = await runGit(['log', '--branches', '--format=%H'], { cwd: repo })
  expect(stdout.trim()).toBe(commit)
  expect(existsSync(payload)).toBe(false)
})

it('ignores inherited GIT_* variables and forbids every transport', async () => {
  vi.stubEnv('GIT_DIR', join(root, 'elsewhere'))
  vi.stubEnv('GIT_SSH_COMMAND', 'planted')
  const { stdout } = await runGit(
    [
      '-c',
      'alias.show-env=!echo "[$GIT_DIR][$GIT_SSH_COMMAND][$GIT_ALLOW_PROTOCOL][$GIT_NO_LAZY_FETCH]"',
      'show-env'
    ],
    { cwd: root }
  )
  expect(stdout.trim()).toBe('[][][none][1]')
})
