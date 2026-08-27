interface VercelRequestContext {
  readonly deadline?: string | number | Date;
}

interface VercelRequestContextProvider {
  get?(): VercelRequestContext | undefined;
}

const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

/** Returns the current Vercel Function deadline when the runtime exposes one. */
export function getInvocationDeadline(): Date | undefined {
  const provider = (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] as
    | VercelRequestContextProvider
    | undefined;
  const value = provider?.get?.()?.deadline;
  if (value === undefined) return undefined;

  const deadline = new Date(value);
  return Number.isNaN(deadline.getTime()) ? undefined : deadline;
}
