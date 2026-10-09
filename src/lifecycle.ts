export class CancelledError extends Error {
  constructor() {
    super('Operation cancelled.');
    this.name = 'CancelledError';
  }
}
export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Database operation exceeded ${timeoutMs} ms. Check reachability and permissions.`);
    this.name = 'TimeoutError';
  }
}
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof TimeoutError || signal.reason instanceof CancelledError
      ? signal.reason
      : new CancelledError();
}
export function isInterrupted(error: unknown): boolean {
  return (
    error instanceof CancelledError ||
    error instanceof TimeoutError ||
    (error instanceof Error &&
      ['AbortError', 'ECANCEL', 'ETIMEOUT', 'PROTOCOL_SEQUENCE_TIMEOUT'].includes(error.name)) ||
    (error instanceof Error && error.message === 'Query read timeout') ||
    (!!error &&
      typeof error === 'object' &&
      [
        'ECANCEL',
        'ETIMEOUT',
        'PROTOCOL_SEQUENCE_TIMEOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'EPIPE',
        'ETIMEDOUT',
        '57014',
        '50',
      ].includes(String((error as { code?: unknown }).code)))
  );
}
/** Install cancellation before starting work; propagate an independent signal to nested operations. */
export async function deadline<T>(
  options: { timeoutMs: number; signal?: AbortSignal },
  work: (signal: AbortSignal) => Promise<T>,
  close: () => void,
): Promise<T> {
  throwIfAborted(options.signal);
  const scope = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let rejectStop: (reason: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  const stop = (reason: Error) => {
    if (scope.signal.aborted) return;
    scope.abort(reason);
    rejectStop(reason);
    try {
      close();
    } catch {
      /* Preserve the cancellation/timeout, even if disposal fails. */
    }
  };
  const abort = () => stop(new CancelledError());
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  timer = setTimeout(() => stop(new TimeoutError(options.timeoutMs)), options.timeoutMs);
  try {
    throwIfAborted(scope.signal);
    const value = await Promise.race([
      Promise.resolve().then(() => {
        throwIfAborted(scope.signal);
        return work(scope.signal);
      }),
      stopped,
    ]);
    throwIfAborted(scope.signal);
    return value;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
/** A resource acquired after cancellation must be disposed before it can be used. */
export async function acquireResource<T>(
  signal: AbortSignal,
  create: () => Promise<T>,
  dispose: (value: T) => void | Promise<void>,
): Promise<T> {
  throwIfAborted(signal);
  const value = await create();
  if (signal.aborted) {
    try {
      await dispose(value);
    } finally {
      throwIfAborted(signal);
    }
  }
  return value;
}
