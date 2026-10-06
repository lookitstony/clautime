import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { AppError } from '../../shared/types/ipc'
import type { SyncReadRequest } from '../workers/folder-sync-read-worker'

/** File parsing and snapshot construction run off-main; batches are acknowledged one at a time. */
export function createSyncReadClient() {
  let cancel: (() => void) | undefined
  return {
    run<T>(
      request: SyncReadRequest,
      onBatch: (batch: unknown) => Promise<void> = async () => {}
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const worker = new Worker(join(__dirname, 'folder-sync-read-worker.js'), {
          workerData: request
        })
        let settled = false
        const finish = (error?: Error, value?: T): void => {
          if (settled) return
          settled = true
          cancel = undefined
          // Release the reader's SQLite/filesystem handles before the next pass or shutdown.
          void worker.terminate().then(() => {
            if (error) reject(error)
            else resolve(value!)
          }, reject)
        }
        cancel = () => finish(new AppError('SYNC_CANCELLED', 'Transfers paused.'))
        worker.on('error', (error) => finish(error))
        worker.on('exit', (code) => {
          if (!settled)
            finish(new AppError('SYNC_WORKER_EXIT', `Shared history reader stopped (${code}).`))
        })
        worker.on('message', (message) => {
          if (settled) return
          if (message.type === 'error')
            finish(new AppError(message.error.code, message.error.message))
          else if (message.type === 'done') finish(undefined, message.value)
          else if (message.type === 'batch') {
            void onBatch(message.batch)
              .then(() => {
                if (!settled) worker.postMessage('next')
              })
              .catch((error) => finish(error))
          }
        })
      })
    },
    cancel() {
      cancel?.()
    }
  }
}
