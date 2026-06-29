import { defineTool } from "eve/tools";
import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";

import {
  CREDENTIAL_PROBE_CLEANUP_PATH,
  CREDENTIAL_PROBE_PATH,
  CREDENTIAL_PROBE_TOKEN,
} from "../credential-probe.js";

export default defineTool({
  description:
    "Vercel-only E2E fixture: verify sandbox firewall credential injection and schedule a post-step cleanup probe. Only call when explicitly asked to use `credential-probe`.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    if (typeof process.env.VERCEL_REGION !== "string") {
      return { mode: "local", supported: false } as const;
    }

    const deploymentHost = process.env.VERCEL_URL;
    if (deploymentHost === undefined || deploymentHost.length === 0) {
      throw new Error("credential-probe: VERCEL_URL is unavailable in a Vercel deployment");
    }

    const sandbox = await ctx.getSandbox();
    const environment = await sandbox.run({
      command: "env; if [ -r /proc/self/environ ]; then tr '\\0' '\\n' < /proc/self/environ; fi",
    });
    const processOutput = `${environment.stdout}\n${environment.stderr}`;
    const oidcToken = await getVercelOidcToken();
    const credentialVisibleToProcess =
      processOutput.includes(CREDENTIAL_PROBE_TOKEN) || processOutput.includes(oidcToken);

    const authorizedUrl = `https://${deploymentHost}${CREDENTIAL_PROBE_PATH}`;
    const authorized = await sandbox.run({
      command: `curl -sS --max-time 15 -w '\\n%{http_code}' ${shellQuote(authorizedUrl)}`,
    });
    const responseBoundary = authorized.stdout.lastIndexOf("\n");
    const responseBody = authorized.stdout.slice(0, responseBoundary);
    const httpStatus = Number(authorized.stdout.slice(responseBoundary + 1));
    const authorizedResponse = parseProbeResponse(responseBody);

    await sandbox.removePath({ force: true, path: CREDENTIAL_PROBE_CLEANUP_PATH });
    await sandbox.spawn({
      command:
        `blocked=0; for attempt in $(seq 1 120); do ` +
        `response=$(curl -sS --max-time 2 ${shellQuote(authorizedUrl)} || true); ` +
        `if [ "$response" = '{"authorized":true}' ]; then blocked=0; ` +
        `else blocked=$((blocked + 1)); fi; ` +
        `if [ "$blocked" -ge 3 ]; then ` +
        `printf blocked > ${shellQuote(CREDENTIAL_PROBE_CLEANUP_PATH)}; exit 0; fi; ` +
        `sleep 0.25; done; printf timeout > ${shellQuote(CREDENTIAL_PROBE_CLEANUP_PATH)}`,
    });

    return {
      authorized: authorized.exitCode === 0 && authorizedResponse.authorized === true,
      credentialVisibleToProcess,
      httpStatus,
      mode: "vercel",
      supported: true,
    } as const;
  },
});

function parseProbeResponse(value: string): { readonly authorized?: unknown } {
  try {
    return JSON.parse(value) as { readonly authorized?: unknown };
  } catch {
    return {};
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
