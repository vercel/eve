import { defineTool } from "eve/tools";
import { z } from "zod";

import { ON_REQUEST_PROBE_PATH } from "../credential-probe.js";

/**
 * Exercises on-request egress credential resolution end to end:
 *
 * 1. The first request hits the unresolved route, is forwarded to the eve
 *    egress proxy, and fails with HTTP 428 while the proxy records
 *    proxy-attested demand in the sandbox.
 * 2. The command exits; eve settles the demand, resolves the credential,
 *    and activates the route in the sandbox network policy.
 * 3. The second request succeeds through the authenticated transform.
 *
 * Both requests run in separate commands inside one tool call because
 * settlement happens when the demanding command exits.
 */
export default defineTool({
  description:
    "Vercel-only E2E fixture: verify on-request sandbox egress credentials resolve after a first 428. Only call when explicitly asked to use `on-request-probe`.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    if (typeof process.env.VERCEL_REGION !== "string") {
      return { mode: "local", supported: false } as const;
    }

    const deploymentHost = process.env.VERCEL_URL;
    if (deploymentHost === undefined || deploymentHost.length === 0) {
      throw new Error("on-request-probe: VERCEL_URL is unavailable in a Vercel deployment");
    }

    const sandbox = await ctx.getSandbox();
    const probeUrl = `https://${deploymentHost}${ON_REQUEST_PROBE_PATH}`;
    const probeCommand = `curl -sS --max-time 15 -w '\\n%{http_code}' ${shellQuote(probeUrl)}`;

    const first = await sandbox.run({ command: probeCommand });
    const second = await sandbox.run({ command: probeCommand });

    return {
      firstBody: parseBody(first.stdout),
      firstStatus: parseStatus(first.stdout),
      mode: "vercel",
      secondBody: parseBody(second.stdout),
      secondStatus: parseStatus(second.stdout),
      supported: true,
    } as const;
  },
});

function parseStatus(stdout: string): number {
  return Number(stdout.slice(stdout.lastIndexOf("\n") + 1));
}

function parseBody(stdout: string): string {
  return stdout.slice(0, stdout.lastIndexOf("\n"));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
