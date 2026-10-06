// Exercise the built worker without starting Electron's app or opening a user database.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

const folder = await mkdtemp(join(tmpdir(), 'clautime-worker-check-'))
const workerPath = resolve(process.argv[2] ?? 'out/main/parse-worker.js')
let worker
try {
  const file = join(folder, 'synthetic.jsonl')
  const sessionId = 'worker-smoke-session'
  await writeFile(
    file,
    JSON.stringify({
      type: 'user',
      timestamp: '2026-09-28T10:00:00.000Z',
      sessionId,
      cwd: folder,
      uuid: 'worker-smoke-message',
      parentUuid: null,
      message: { role: 'user', content: 'Synthetic worker check' }
    }) + '\n'
  )
  worker = new Worker(
    `const Module = require('node:module');
     const load = Module._load;
     // Packaged Electron workers cannot require Electron. The dev dependency can mask this.
     Module._load = function (id, ...args) {
       if (id === 'electron') throw new Error("Cannot find module 'electron'");
       return load.call(this, id, ...args);
     };
     import(${JSON.stringify(pathToFileURL(workerPath).href)});`,
    {
      eval: true,
      stdout: true,
      stderr: true,
      env: { ...process.env, APPDATA: folder, XDG_CONFIG_HOME: folder }
    }
  )
  // Drain output without exposing parsed data or letting worker warnings write app logs.
  worker.stdout.resume()
  worker.stderr.resume()
  const response = await new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => reject(new Error('Parse worker did not respond')), 15000)
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    const finish = (callback, value) => {
      clearTimeout(timer)
      callback(value)
    }
    worker.once('message', (value) => finish(resolveResponse, value))
    worker.once('error', (error) => finish(reject, error))
    worker.once('exit', (code) => finish(reject, new Error(`Worker exited: ${code}`)))
    worker.postMessage({
      entries: [
        { path: file, providerId: 'claude' },
        { path: join(folder, 'missing.jsonl'), providerId: 'claude' }
      ],
      offsets: {}
    })
  })
  assert.equal(response.results.length, 2)
  assert.equal(response.results[0]?.sessionId, sessionId)
  assert.equal(response.results[0]?.messages.length, 1)
  assert.equal(response.results[1], null)
  console.log(
    'PASS: built parse worker starts, parses synthetic history and handles a missing file'
  )
} finally {
  await worker?.terminate()
  await rm(folder, { recursive: true, force: true })
}
