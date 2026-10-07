// Kept free of runtime eve imports so it loads without a built eve.

/** Session state of the wrapped Vercel provider, plus adapter fields. */
export type EveGhSessionState = {
  readonly sandboxName: string;
  readonly version: 3;
  readonly devboxId?: string;
};

/** The part of eve's provider session context that credential resolution reads. */
export interface EveGhSessionContext {
  readonly session: { readonly id: string };
}

export function requireState(state: unknown): EveGhSessionState {
  if (typeof state !== "object" || state === null) {
    throw new Error("Invalid eve-gh sandbox state.");
  }
  const { sandboxName, version, devboxId } = state as Record<string, unknown>;
  if (typeof sandboxName !== "string" || version !== 3) {
    throw new Error("Invalid eve-gh sandbox state.");
  }
  if (devboxId !== undefined && typeof devboxId !== "string") {
    throw new Error("Invalid persisted Devbox identity.");
  }
  return devboxId === undefined ? { sandboxName, version } : { sandboxName, version, devboxId };
}
