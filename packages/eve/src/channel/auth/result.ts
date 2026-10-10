import type { SessionAuthContext } from "#channel/types.js";
import type { AuthResult } from "#public/channels/auth.js";

/** Do not save this request's stub permission or forward it to another agent. */
export function sessionAuthFromResult(result: AuthResult): SessionAuthContext {
  const { allowToolStubs: _allowToolStubs, ...auth } = result;
  return auth;
}
