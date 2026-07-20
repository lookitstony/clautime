import { readdir, readFile } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import log from 'electron-log/main.js'
import type { ParsedSessionData, ParsedMessage, TokenUsage } from './types'

/**
 * Parser for OpenCode (opencode.ai) session storage.
 *
 * OpenCode keeps a document store under <data-dir>/storage:
 *   storage/session/<projectID>/ses_<id>.json   — session metadata
 *       { id, projectID, directory, title, time: { created, updated } }
 *   storage/message/<sessionID>/msg_<id>.json   — one file per message
 *       { id, sessionID, role, time: { created, completed? }, parentID?,
 *         modelID?, providerID?, tokens?: { input, output, reasoning,
 *         cache: { read, write } } }
 *   storage/part/<messageID>/prt_<id>.json      — message parts (text, tool
 *       calls with state.time.start/end, step markers)
 *
 * The data dir is $OPENCODE_DATA_DIR (first entry if comma-separated), else
 * $XDG_DATA_HOME/opencode, else ~/.local/share/opencode — the same default on
 * every platform, including Windows.
 *
 * A "session file" for the provider pipeline is the ses_*.json metadata file;
 * parsing it pulls in that session's message (and part) files. Timestamps are
 * epoch milliseconds and are converted to ISO strings.
 *
 * Output is the same ParsedSessionData shape the Claude parser emits, so the
 * whole downstream pipeline (raw storage, gap detection, rebuild) is shared.
 */

function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0
  }
}

/** Resolve the OpenCode storage root, honoring OPENCODE_DATA_DIR / XDG_DATA_HOME. */
export function getOpencodeStorageDir(): string {
  const envDir = process.env.OPENCODE_DATA_DIR?.split(',')[0]?.trim()
  if (envDir) return join(envDir, 'storage')
  const xdg = process.env.XDG_DATA_HOME?.trim()
  const dataBase = xdg || join(homedir(), '.local', 'share')
  return join(dataBase, 'opencode', 'storage')
}

/** Enumerate every session metadata file: {storage}/session/<projectID>/ses_*.json */
export async function discoverOpencodeSessionFiles(storageDir?: string): Promise<string[]> {
  const root = storageDir ?? getOpencodeStorageDir()
  const sessionRoot = join(root, 'session')
  const files: string[] = []

  let projectDirs: import('node:fs').Dirent<string>[]
  try {
    projectDirs = await readdir(sessionRoot, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return files // No storage/session — OpenCode not installed
  }

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue
    const projectDir = join(sessionRoot, dir.name)
    try {
      const entries = await readdir(projectDir, { withFileTypes: true, encoding: 'utf8' })
      for (const entry of entries) {
        if (entry.isFile() && entry.name.startsWith('ses_') && entry.name.endsWith('.json')) {
          files.push(join(projectDir, entry.name))
        }
      }
    } catch {
      continue
    }
  }

  return files
}

/**
 * Enumerate every file that holds conversation TEXT (message + part files),
 * for the secret scanner. Session metadata files carry only titles/paths, and
 * discoverOpencodeSessionFiles returns just those — this walks the real
 * transcript content instead.
 */
export async function discoverOpencodeTranscriptFiles(storageDir?: string): Promise<string[]> {
  const root = storageDir ?? getOpencodeStorageDir()
  const files: string[] = []

  for (const subdir of ['message', 'part']) {
    let groups: import('node:fs').Dirent<string>[]
    try {
      groups = await readdir(join(root, subdir), { withFileTypes: true, encoding: 'utf8' })
    } catch {
      continue
    }
    for (const group of groups) {
      if (!group.isDirectory()) continue
      const groupDir = join(root, subdir, group.name)
      try {
        const entries = await readdir(groupDir, { withFileTypes: true, encoding: 'utf8' })
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.json')) files.push(join(groupDir, entry.name))
        }
      } catch {
        continue
      }
    }
  }

  return files
}

interface OpencodeSessionInfo {
  id?: string
  projectID?: string
  directory?: string
  title?: string
}

interface OpencodeMeta {
  sessionId: string
  cwd: string | null
}

/** {storage}/session/<projectID>/ses_x.json → {storage} */
function storageRootFor(sessionFile: string): string {
  return dirname(dirname(dirname(sessionFile)))
}

async function readSessionInfo(sessionFile: string): Promise<OpencodeSessionInfo | null> {
  try {
    return JSON.parse(await readFile(sessionFile, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Resolve a session's working directory. Modern sessions carry `directory`;
 * older ones only reference a project whose worktree lives in
 * storage/project/<projectID>.json. The "global" project's worktree is "/",
 * which is not a real project path.
 */
async function resolveSessionCwd(
  sessionFile: string,
  info: OpencodeSessionInfo
): Promise<string | null> {
  if (info.directory && info.directory !== '/') return info.directory
  if (!info.projectID) return null
  try {
    const projectFile = join(storageRootFor(sessionFile), 'project', `${info.projectID}.json`)
    const project = JSON.parse(await readFile(projectFile, 'utf-8')) as { worktree?: string }
    return project.worktree && project.worktree !== '/' ? project.worktree : null
  } catch {
    return null
  }
}

/** Session id + cwd from the (small) session metadata file. */
export async function readOpencodeSessionMeta(sessionFile: string): Promise<OpencodeMeta | null> {
  const info = await readSessionInfo(sessionFile)
  if (!info) return null
  return {
    sessionId: info.id || basename(sessionFile, '.json'),
    cwd: await resolveSessionCwd(sessionFile, info)
  }
}

interface OpencodeMessage {
  id?: string
  role?: string
  parentID?: string
  modelID?: string
  time?: { created?: number; completed?: number }
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

interface OpencodePart {
  type?: string
  tool?: string
  state?: { time?: { start?: number; end?: number } }
}

function toIso(epochMs: number | undefined): string | null {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs) || epochMs <= 0) return null
  return new Date(epochMs).toISOString()
}

/**
 * Map an assistant message's token block to the shared TokenUsage shape.
 * `reasoning` tokens are billed as output; cache read/write are reported
 * separately from `input` (whether `input` already includes cache reads varies
 * by upstream provider — values are taken as reported, matching ccusage).
 */
function usageFromTokens(tokens: NonNullable<OpencodeMessage['tokens']>): TokenUsage | null {
  const usage: TokenUsage = {
    inputTokens: tokens.input || 0,
    outputTokens: (tokens.output || 0) + (tokens.reasoning || 0),
    cacheCreationInputTokens: tokens.cache?.write || 0,
    cacheReadInputTokens: tokens.cache?.read || 0
  }
  return usage.inputTokens ||
    usage.outputTokens ||
    usage.cacheCreationInputTokens ||
    usage.cacheReadInputTokens
    ? usage
    : null
}

/**
 * Read an assistant message's parts for tool names and tool-execution
 * timestamps (progress evidence during long tool runs).
 */
async function readMessageParts(
  storageRoot: string,
  messageId: string
): Promise<{ toolNames: string[]; progressTimestamps: string[] }> {
  const toolNames: string[] = []
  const progressTimestamps: string[] = []
  const partDir = join(storageRoot, 'part', messageId)

  let entries: string[]
  try {
    entries = await readdir(partDir)
  } catch {
    return { toolNames, progressTimestamps }
  }

  for (const name of entries) {
    if (!name.startsWith('prt_') || !name.endsWith('.json')) continue
    let part: OpencodePart
    try {
      part = JSON.parse(await readFile(join(partDir, name), 'utf-8'))
    } catch {
      continue
    }
    if (part.type !== 'tool') continue
    if (part.tool && !toolNames.includes(part.tool)) toolNames.push(part.tool)
    const start = toIso(part.state?.time?.start)
    const end = toIso(part.state?.time?.end)
    if (start) progressTimestamps.push(start)
    if (end) progressTimestamps.push(end)
  }

  return { toolNames, progressTimestamps }
}

/**
 * Parse an OpenCode session (metadata file + its message/part files) into
 * ParsedSessionData. Returns null for unreadable or message-less sessions.
 */
export async function parseOpencodeSessionFile(
  sessionFile: string
): Promise<ParsedSessionData | null> {
  const info = await readSessionInfo(sessionFile)
  if (!info) {
    log.warn(`Failed to read OpenCode session file: ${sessionFile}`)
    return null
  }

  const sessionId = info.id || basename(sessionFile, '.json')
  const projectDirectory = await resolveSessionCwd(sessionFile, info)
  const storageRoot = storageRootFor(sessionFile)
  const messageDir = join(storageRoot, 'message', sessionId)

  let messageFiles: string[]
  try {
    messageFiles = (await readdir(messageDir)).filter(
      (n) => n.startsWith('msg_') && n.endsWith('.json')
    )
  } catch {
    return null // no messages recorded — nothing billable
  }

  const messages: ParsedMessage[] = []
  const progressTimestamps: string[] = []
  const totalUsage = emptyTokenUsage()
  const modelsSet = new Set<string>()

  for (const name of messageFiles) {
    let msg: OpencodeMessage
    try {
      msg = JSON.parse(await readFile(join(messageDir, name), 'utf-8'))
    } catch {
      log.warn(`Malformed OpenCode message file ${name} in ${messageDir}, skipping`)
      continue
    }
    const timestamp = toIso(msg.time?.created)
    if (!timestamp) continue

    if (msg.role === 'user') {
      messages.push({
        type: 'user',
        timestamp,
        sessionId,
        cwd: projectDirectory,
        gitBranch: null,
        model: null,
        usage: null,
        uuid: msg.id ?? null,
        parentUuid: msg.parentID ?? null,
        isToolResult: false,
        hasToolUse: false,
        toolNames: []
      })
      continue
    }

    if (msg.role === 'assistant') {
      const usage = msg.tokens ? usageFromTokens(msg.tokens) : null
      if (usage) {
        totalUsage.inputTokens += usage.inputTokens
        totalUsage.outputTokens += usage.outputTokens
        totalUsage.cacheCreationInputTokens += usage.cacheCreationInputTokens
        totalUsage.cacheReadInputTokens += usage.cacheReadInputTokens
      }
      if (msg.modelID) modelsSet.add(msg.modelID)

      const parts = msg.id
        ? await readMessageParts(storageRoot, msg.id)
        : { toolNames: [], progressTimestamps: [] }
      progressTimestamps.push(...parts.progressTimestamps)
      const completed = toIso(msg.time?.completed)
      if (completed) progressTimestamps.push(completed)

      messages.push({
        type: 'assistant',
        timestamp,
        sessionId,
        cwd: projectDirectory,
        gitBranch: null,
        model: msg.modelID ?? null,
        usage,
        uuid: msg.id ?? null,
        parentUuid: msg.parentID ?? null,
        isToolResult: false,
        hasToolUse: parts.toolNames.length > 0,
        toolNames: parts.toolNames
      })
    }
    // other roles (if any) — ignore
  }

  if (messages.length === 0) return null

  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  progressTimestamps.sort()

  const timestamps = messages.map((m) => m.timestamp)

  return {
    sessionId,
    sourceFile: sessionFile,
    tool: 'opencode',
    projectPathEncoded: '', // OpenCode has no encoded-dir convention; cwd is authoritative
    projectDirectory,
    messages,
    progressTimestamps,
    firstTimestamp: timestamps[0] ?? null,
    lastTimestamp: timestamps[timestamps.length - 1] ?? null,
    totalTokenUsage: totalUsage,
    subagentTokenUsage: emptyTokenUsage(),
    models: Array.from(modelsSet),
    messageCount: messages.length,
    summary: info.title || null,
    subagentMessages: [],
    subagentProgressTimestamps: []
  }
}
