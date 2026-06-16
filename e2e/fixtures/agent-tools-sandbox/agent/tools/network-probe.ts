import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Applies a `deny-all` network policy to the live sandbox mid-turn via
 * `sandbox.setNetworkPolicy(...)`, then attempts an HTTP egress with `curl`
 * and reports whether it was blocked.
 *
 * The assertion the eval gates on is self-contained: under `deny-all` the
 * sandbox has no egress at all (the Docker backend detaches every network, the
 * Vercel firewall blocks the request), so `curl` fails without depending on
 * any external host being reachable. `blocked` plus a network-failure `stderr`
 * signature distinguishes a policy block from `curl` being missing.
 */
export default defineTool({
  description:
    "Smoke-test fixture: applies a deny-all network policy to the sandbox and probes egress. Only call when explicitly asked to use `network-probe`.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    await sandbox.setNetworkPolicy("deny-all");
    const result = await sandbox.run({
      command: "curl -sS --max-time 5 -o /dev/null https://example.com",
    });
    return {
      blocked: result.exitCode !== 0,
      exitCode: result.exitCode,
      stderr: result.stderr,
    };
  },
});
