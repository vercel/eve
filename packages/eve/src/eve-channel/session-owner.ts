import { createHash } from "node:crypto";

import type { SessionAuthContext } from "#channel/types.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";

export const HTTP_SESSION_OWNER_ATTRIBUTE = "eve.http.owner.v1";

/** The authority tag keeps explicit issuers distinct from authenticator fallback names. */
export function httpSessionOwnerKey(
  caller: SessionAuthContext | null | undefined,
): string | undefined {
  if (caller?.principalType !== "user") return undefined;
  const authority =
    caller.issuer === undefined
      ? ["authenticator", caller.authenticator]
      : ["issuer", caller.issuer];
  return createHash("sha256")
    .update(JSON.stringify([caller.principalType, authority, caller.principalId]))
    .digest("hex");
}

/** Initial run metadata remains readable after workflow data and side streams are purged. */
export async function isHttpSessionOwner(
  sessionId: string,
  caller: SessionAuthContext,
): Promise<boolean> {
  const key = httpSessionOwnerKey(caller);
  if (key === undefined) return false;
  try {
    const run = await (await getWorld()).runs.get(sessionId, { resolveData: "none" });
    return run.attributes[HTTP_SESSION_OWNER_ATTRIBUTE] === key;
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error)) return false;
    throw error;
  }
}
