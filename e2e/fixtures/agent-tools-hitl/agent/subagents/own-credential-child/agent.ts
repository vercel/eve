import { defineAgent } from "eve";

import { ownCredentialModel } from "../../lib/model-sign-in.ts";

/** A declared subagent on the caller's own model credential: its first model call asks to sign in. */
export default defineAgent({
  description: "Answers on the caller's own model credential. Call only when explicitly requested.",
  model: ownCredentialModel,
  modelContextWindowTokens: 1_000_000,
});
