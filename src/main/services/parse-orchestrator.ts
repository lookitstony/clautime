import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import log from 'electron-log/main.js'
import { providerRegistry } from '../providers'
import type { ParsedSessionData } from '../parsers/types'
import type { SessionTool } from '../../shared/types/session'
import type { ParseWorkRequest, ParseWorkResponse } from '../workers/parse-worker'

export interface ParseEntry {
  path: string
  providerId: SessionTool
}

/** Hung-worker backstop — far above any real parse batch. */
const WORKER_TIMEOUT_MS = 10 * 60 * 1000

const workerPath = join(__dirname, 'parse-worker.js')

function parserById(id: SessionTool): NonNullable<(typeof providerRegistry)[number]> {
  const p = providerRegistry.find((r) => r.id === id)
  if (!p) throw new Error(`Unknown provider id: ${id}`)
  return p
}

async function parseInline(
  entries: ParseEntry[],
  offsets: Record<string, number>
): Promise<(ParsedSessionData | null)[]> {
  const results: (ParsedSessionData | null)[] = []
  for (const entry of entries) {
    try {
      results.push(await parserById(entry.providerId).parseFile(entry.path, { offsets }))
    } catch (err) {
      log.warn(`Parse failed for ${entry.path}:`, err)
      results.push(null)
    }
  }
  return results
}

function parseInWorker(
  entries: ParseEntry[],
  offsets: Record<string, number>
): Promise<(ParsedSessionData | null)[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath)
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error(`Parse worker timed out after ${WORKER_TIMEOUT_MS}ms`))
    }, WORKER_TIMEOUT_MS)

    const finish = (fn: () => void): void => {
      clearTimeout(timer)
      void worker.terminate()
      fn()
    }

    worker.on('message', (res: ParseWorkResponse) => finish(() => resolve(res.results)))
    worker.on('error', (err) => finish(() => reject(err)))
    worker.on('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`Parse worker exited with code ${code}`)))
    })

    const req: ParseWorkRequest = { entries, offsets }
    worker.postMessage(req)
  })
}

/**
 * Parse session files off the main thread when the bundled worker is available
 * (production and dev builds); fall back to in-process parsing under vitest or
 * if the worker fails. Results keep the order of `entries`.
 */
export async function parseSessionFiles(
  entries: ParseEntry[],
  offsets: Record<string, number>
): Promise<(ParsedSessionData | null)[]> {
  if (entries.length === 0) return []
  if (process.env.VITEST || !existsSync(workerPath)) {
    return parseInline(entries, offsets)
  }
  try {
    return await parseInWorker(entries, offsets)
  } catch (err) {
    log.warn('Parse worker failed — falling back to in-process parsing:', err)
    return parseInline(entries, offsets)
  }
}
