import { execFile, type ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Runs git in a folder ClauTime discovered but does not trust. A planted `.git/config` could
 * otherwise run programs: a partial clone lazily fetches missing objects over a transport
 * (`core.sshCommand`, `ext::`), `log.showSignature` calls `gpg.program`, and hooks or fsmonitor
 * run local programs. ClauTime only reads history, so all of that is switched off per call.
 */
export function runGit(
  args: string[],
  options: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  // Inherited GIT_* variables (GIT_DIR, GIT_SSH_COMMAND, GIT_CONFIG_*, ...) would redirect or
  // reconfigure every call; only the caller's own options.env may set them.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))
  )
  return execFileAsync(
    'git',
    [
      '-c',
      'core.sshCommand=',
      '-c',
      'protocol.allow=never',
      '-c',
      'log.showSignature=false',
      '-c',
      'core.fsmonitor=false',
      '-c',
      `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      ...args
    ],
    {
      windowsHide: true,
      ...options,
      encoding: 'utf8',
      env: {
        ...inherited,
        ...options.env,
        // Overrides per-protocol `protocol.<name>.allow` repo config, unlike protocol.allow.
        GIT_ALLOW_PROTOCOL: 'none',
        GIT_NO_LAZY_FETCH: '1',
        GIT_TERMINAL_PROMPT: '0'
      }
    }
  ) as Promise<{ stdout: string; stderr: string }>
}
