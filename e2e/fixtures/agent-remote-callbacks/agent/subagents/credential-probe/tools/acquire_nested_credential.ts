import { defineTool, getAuthorizationResult, getHookUrl, requestAuthorization } from "eve/tools";
import { z } from "zod";

/**
 * Same deterministic authorization trigger as the root
 * `acquire_probe_credential` tool, but owned by a local subagent: when this
 * agent runs as a remote callee's child, its `authorization.*` events must
 * relay two hops — local proxy to the callee's stream, then a notification
 * callback to the original caller.
 */
export default defineTool({
  description: "Acquire the nested probe credential. Requires out-of-band user authorization.",
  inputSchema: z.object({}),
  async execute() {
    const result = getAuthorizationResult("nested-probe");
    if (result === undefined) {
      const hookUrl = getHookUrl("nested-probe");
      if (hookUrl === undefined) {
        throw new Error("acquire_nested_credential: no session context for authorization.");
      }
      return requestAuthorization([
        {
          name: "nested-probe",
          challenge: { url: hookUrl, instructions: "Open the link to authorize the probe." },
          hookUrl,
        },
      ]);
    }
    const code = result.callback.params["code"] ?? "missing-code";
    return { credential: `NESTED-CREDENTIAL-${code}` };
  },
});
