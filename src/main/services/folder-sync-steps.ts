/** Synchronous callers keep atomic operations; the coordinator yields only between operations. */
export function finishSyncSteps<T>(steps: Generator<void, T>): T {
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}

export async function finishSyncStepsAsync<T>(
  steps: Generator<void, T>,
  yieldControl: () => Promise<void>
): Promise<T> {
  try {
    let step = steps.next()
    while (!step.done) {
      await yieldControl()
      step = steps.next()
    }
    return step.value
  } finally {
    steps.return(undefined as T)
  }
}
