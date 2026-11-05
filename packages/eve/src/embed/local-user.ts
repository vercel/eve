import { userInfo } from "node:os";

import type { SessionAuthContext } from "#channel/types.js";

/**
 * The user this process runs as, as the principal of a session on that user's own machine: what
 * a local CLI passes as `createSession(agent, { identity: localUser() })`. Not for a server, whose
 * process user isn't the person in the conversation.
 */
export function localUser(): SessionAuthContext {
  let username = "local";
  try {
    username = userInfo().username || username;
  } catch {
    // Some hosts have no user database entry for the process; it still runs as someone local.
  }
  return {
    attributes: {},
    authenticator: "embedded",
    issuer: "local",
    principalId: username,
    principalType: "user",
  };
}
