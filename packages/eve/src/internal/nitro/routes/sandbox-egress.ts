import * as sandboxModule from "#compiled/@vercel/sandbox/index.js";
import { defineSandboxProxy } from "#compiled/@vercel/sandbox/proxy.js";
import { getVercelSandboxCredentials } from "#execution/sandbox/bindings/vercel-credentials.js";
import { getNamedVercelSandbox } from "#execution/sandbox/bindings/vercel-lookup.js";
import {
  getVercelEgressDemandMarkerPath,
  isVercelEgressDemandToken,
  isVercelEgressRuleId,
} from "#execution/sandbox/bindings/vercel-egress-demand.js";
import { createLogger, logError } from "#internal/logging.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

const EGRESS_ROUTE_PREFIX = `${EVE_ROUTE_PREFIX}/sandbox/egress/`;
const log = createLogger("sandbox.egress-proxy");

type EgressProxyStage = "credentials" | "sandbox_lookup" | "marker_write";

export default async function sandboxEgressRoute(event: {
  readonly req: Request;
}): Promise<Response> {
  const route = readRoute(event.req.url);
  if (route === undefined) return new Response("Not found", { status: 404 });

  const handleProxyRequest = defineSandboxProxy(
    async (_request, meta) => {
      let stage: EgressProxyStage = "credentials";
      try {
        const credentials = await getVercelSandboxCredentials({});
        if (credentials.projectId !== meta.projectId || credentials.teamId !== meta.teamId) {
          return new Response(
            "eve: this egress route only serves sandboxes of the project that deployed it.",
            { status: 403 },
          );
        }

        stage = "sandbox_lookup";
        const sandbox = await getNamedVercelSandbox({
          createOptions: {},
          sandboxModule,
          sandboxName: route.sandboxName,
        });
        if (sandbox === null || sandbox.currentSession().sessionId !== meta.sandboxId) {
          return new Response(
            "eve: this egress route only serves requests from the sandbox it was issued for.",
            { status: 403 },
          );
        }

        stage = "marker_write";
        // The marker content is the host-minted demand token from the
        // forwardURL. The sandbox can write marker files but never learns a
        // valid token, so only proxy-attested demand passes verification.
        await sandbox.writeFiles([
          {
            content: new TextEncoder().encode(route.demandToken),
            path: getVercelEgressDemandMarkerPath(route.ruleId),
          },
        ]);
        return new Response(
          "eve: this route requires authorization. The request was recorded and " +
            "authorization is being requested; re-run this command once it is granted.",
          { status: 428 },
        );
      } catch (error) {
        const errorId = logError(log, "sandbox egress proxy failed", error, {
          ruleId: route.ruleId,
          sandboxId: meta.sandboxId,
          sandboxName: route.sandboxName,
          stage,
        });
        return Response.json(
          {
            error:
              "eve: the egress proxy could not record this authorization request; " +
              "the route stays closed. Re-run the command to request authorization again.",
            errorId,
            stage,
          },
          { status: 500 },
        );
      }
    },
    () =>
      new Response(
        "eve: this endpoint only serves requests forwarded by a Vercel Sandbox firewall rule.",
        { status: 403 },
      ),
  );
  return await handleProxyRequest(event.req);
}

function readRoute(
  url: string,
):
  | { readonly demandToken: string; readonly ruleId: string; readonly sandboxName: string }
  | undefined {
  const pathname = new URL(url).pathname;
  if (!pathname.startsWith(EGRESS_ROUTE_PREFIX)) return undefined;
  const [ruleId, encodedSandboxName, demandToken] = pathname
    .slice(EGRESS_ROUTE_PREFIX.length)
    .split("/");
  if (
    ruleId === undefined ||
    !isVercelEgressRuleId(ruleId) ||
    encodedSandboxName === undefined ||
    demandToken === undefined ||
    !isVercelEgressDemandToken(demandToken)
  ) {
    return undefined;
  }
  try {
    const sandboxName = decodeURIComponent(encodedSandboxName);
    if (sandboxName.length === 0 || sandboxName.includes("/") || sandboxName.includes("\0")) {
      return undefined;
    }
    return { demandToken, ruleId, sandboxName };
  } catch {
    return undefined;
  }
}
