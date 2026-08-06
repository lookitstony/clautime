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

/**
 * Stream lines starting at a byte offset, for incremental re-parsing of
 * actively-growing JSONL files. The generator's RETURN value is the byte offset
 * just past the last complete (newline-terminated) line consumed — persist it
 * and pass it back as `start` on the next scan to read only appended data.
 *
 * A trailing partial line (no terminating \n yet) IS yielded so callers see the
 * freshest data, but it is NOT counted in the returned offset, so the next
 * incremental read picks it up again once complete. Byte tracking requires
 * splitting on raw buffers here rather than readline.
 */
export async function* readJsonlLinesFrom(
  filePath: string,
  start: number
): AsyncGenerator<string, number> {
  const stream = createReadStream(filePath, { start })
  let consumed = start
  let pending: Buffer[] = []
  let pendingBytes = 0

  const decodeLine = (buf: Buffer): string => {
    // Strip \r for \r\n terminators; byte accounting uses the raw length + \n
    const end = buf.length > 0 && buf[buf.length - 1] === 0x0d ? buf.length - 1 : buf.length
    return buf.toString('utf-8', 0, end)
  }

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let searchFrom = 0
      while (true) {
        const nl = chunk.indexOf(0x0a, searchFrom)
        if (nl === -1) break
        const lineBuf =
          pending.length > 0
            ? Buffer.concat([...pending, chunk.subarray(searchFrom, nl)])
            : chunk.subarray(searchFrom, nl)
        consumed += pendingBytes + (nl - searchFrom) + 1
        pending = []
        pendingBytes = 0
        const line = decodeLine(lineBuf)
        if (line.trim()) yield line
        searchFrom = nl + 1
      }
      if (searchFrom < chunk.length) {
        const rest = chunk.subarray(searchFrom)
        pending.push(rest)
        pendingBytes += rest.length
      }
    }
    // Trailing partial line: yield but don't advance `consumed`
    if (pending.length > 0) {
      const line = decodeLine(Buffer.concat(pending))
      if (line.trim()) yield line
    }
    return consumed
  } finally {
    stream.destroy()
  }
}

/**
 * True when `offset` sits exactly on a line boundary in the file (byte before
 * it is \n), so an incremental read from there cannot start mid-line. Offset 0
 * is always valid. Used to reject stale/corrupt persisted offsets.
 */
export async function isLineBoundary(filePath: string, offset: number): Promise<boolean> {
  if (offset <= 0) return true
  const { open } = await import('node:fs/promises')
  let fh
  try {
    fh = await open(filePath, 'r')
    const buf = Buffer.alloc(1)
    const { bytesRead } = await fh.read(buf, 0, 1, offset - 1)
    return bytesRead === 1 && buf[0] === 0x0a
  } catch {
    return false
  } finally {
    await fh?.close()
  }
}
