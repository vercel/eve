import { defineTool, getAuthorizationResult, getHookUrl, requestAuthorization } from "eve/tools";
import { z } from "zod";

/**
 * Deterministic `authorization.*` trigger for the remote-callback evals.
 *
 * First execution parks the turn on an authorization hook; the eval
 * completes it by fetching the `webhookUrl` from the forwarded
 * `authorization.required` event with a `?code=` query parameter. The
 * re-execution reads that code back, so the credential in the final
 * reply proves the callback propagated end to end.
 */
export default defineTool({
  description: "Acquire the probe credential. Requires out-of-band user authorization.",
  inputSchema: z.object({}),
  async execute() {
    const result = getAuthorizationResult("probe");
    if (result === undefined) {
      const hookUrl = getHookUrl("probe");
      if (hookUrl === undefined) {
        throw new Error("acquire_probe_credential: no session context for authorization.");
      }
      return requestAuthorization([
        {
          name: "probe",
          challenge: { url: hookUrl, instructions: "Open the link to authorize the probe." },
          hookUrl,
        },
      ]);
    }
    const code = result.callback.params["code"] ?? "missing-code";
    return { credential: `PROBE-CREDENTIAL-${code}` };
  },
});
