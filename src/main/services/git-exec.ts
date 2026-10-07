import { execFile, type ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Runs git in a folder ClauTime discovered but does not trust. A planted `.git/config` could
 * otherwise run commands: a partial clone lazily fetches missing objects through
 * `core.sshCommand`, and hooks or fsmonitor run local programs. ClauTime only reads history,
 * so network access, hooks and fsmonitor are switched off for every call.
 */
export function runGit(
  args: string[],
  options: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    'git',
    [
      '-c',
      'core.sshCommand=',
      '-c',
      'protocol.allow=never',
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
      env: { ...process.env, ...options.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }
    }
  ) as Promise<{ stdout: string; stderr: string }>
}
