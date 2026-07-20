import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/**
 * Stream the non-empty lines of a (potentially very large) JSONL file without
 * loading the whole thing into memory. A 74MB rollout otherwise costs a 74MB
 * string plus an equally large line array at once; streaming keeps memory flat
 * and lets the event loop breathe between stream chunks.
 *
 * Line terminators (\n and \r\n) are stripped, matching a `split('\n')` +
 * trim-filter, so callers see the same lines they did before. Read errors
 * (missing/locked file) surface as a thrown error while iterating — callers
 * wrap the loop and return null, exactly as the old readFile try/catch did.
 */
export async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (line.trim()) yield line
    }
  } finally {
    rl.close()
    stream.destroy()
  }
}
