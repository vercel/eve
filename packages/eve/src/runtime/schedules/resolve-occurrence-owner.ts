import type { Runtime } from "#channel/types.js";
import { OccurrenceAdmissionPendingError } from "#shared/occurrence-admission-errors.js";

const CREATE_ONCE_OWNER_TIMEOUT_MS = 5_000;
const CREATE_ONCE_OWNER_POLL_MS = 20;

/** Thrown when a create-once claim has not settled; callers should retry the delivery. */
export class CreateOnceClaimPendingError extends Error {
  readonly continuationToken: string;
  constructor(continuationToken: string) {
    super(`Create-once claim "${continuationToken}" did not settle; retry the delivery.`);
    this.name = "CreateOnceClaimPendingError";
    this.continuationToken = continuationToken;
  }
}

/**
 * Continuation claims settle inside workflow startup, so a redelivered
 * occurrence may start a workflow that loses the claim. Only a resolved
 * claim identifies the admitted session; an unsettled claim is never
 * reported as admitted.
 */
export async function resolveCreateOnceOwner(
  runtime: Runtime,
  continuationToken: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + (options.timeoutMs ?? CREATE_ONCE_OWNER_TIMEOUT_MS);
  while (true) {
    try {
      const owner = await runtime.resolveContinuation(continuationToken);
      if (owner !== undefined) return owner.sessionId;
    } catch (error) {
      if (!(error instanceof OccurrenceAdmissionPendingError)) throw error;
    }
    if (Date.now() >= deadline) throw new CreateOnceClaimPendingError(continuationToken);
    await new Promise<void>((resolve) => setTimeout(resolve, CREATE_ONCE_OWNER_POLL_MS));
  }
}
