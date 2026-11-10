const DONE: IteratorReturnResult<undefined> = { done: true, value: undefined };

/**
 * One read of an iterator, or done once `signal` aborts. The abort listener lives only
 * as long as the read, so a long stream read many times leaves nothing on the signal;
 * racing every read against one promise that settles only on stop kept them all.
 */
export function untilAborted<T>(
  read: Promise<IteratorResult<T>>,
  signal: AbortSignal,
): Promise<IteratorResult<T, unknown>> {
  if (signal.aborted) return Promise.resolve(DONE);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(DONE);
    signal.addEventListener("abort", onAbort, { once: true });
    read.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
