/**
 * Stops consuming `stream` as soon as `failureSignal` aborts, including while
 * the underlying iterator is stalled in `next()`.
 */
export async function* interruptStreamOnFailure<T>(
  stream: AsyncIterable<T>,
  failureSignal: AbortSignal,
): AsyncIterable<T> {
  const iterator = stream[Symbol.asyncIterator]();
  let completed = false;

  try {
    while (true) {
      const result = await nextOrFailure(iterator, failureSignal);
      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!completed && iterator.return !== undefined) {
      try {
        const closing = iterator.return();
        void Promise.resolve(closing).catch(() => {});
      } catch {}
    }
  }
}

function nextOrFailure<T>(
  iterator: AsyncIterator<T>,
  failureSignal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (failureSignal.aborted) return Promise.reject(failureSignal.reason);

  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const onFailure = (): void => {
      reject(failureSignal.reason);
    };
    failureSignal.addEventListener("abort", onFailure, { once: true });
    let next: Promise<IteratorResult<T>>;
    try {
      next = iterator.next();
    } catch (error) {
      failureSignal.removeEventListener("abort", onFailure);
      reject(error);
      return;
    }
    next.then(
      (result) => {
        failureSignal.removeEventListener("abort", onFailure);
        resolve(result);
      },
      (error: unknown) => {
        failureSignal.removeEventListener("abort", onFailure);
        reject(error);
      },
    );
  });
}
