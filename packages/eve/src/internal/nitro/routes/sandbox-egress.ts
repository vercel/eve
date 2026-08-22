import { Sandbox } from "#compiled/@vercel/sandbox/index.js";
import { defineSandboxProxy } from "#compiled/@vercel/sandbox/proxy.js";
import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import { getVercelEgressDemandMarkerPath } from "#execution/sandbox/bindings/vercel-egress-demand.js";
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
        const createOptions = {};
        const credentials = await getVercelSandboxCredentials(createOptions);
        if (credentials.projectId !== meta.projectId || credentials.teamId !== meta.teamId) {
          return new Response("Forbidden", { status: 403 });
        }

        stage = "sandbox_lookup";
        const sandbox = await Sandbox.get({
          ...credentials,
          fetch: getVercelSandboxFetch(createOptions),
          name: route.sandboxName,
          resume: false,
        } as never);
        if (sandbox.currentSession().sessionId !== meta.sandboxId) {
          return new Response("Forbidden", { status: 403 });
        }

        stage = "marker_write";
        await sandbox.writeFiles([
          {
            content: new TextEncoder().encode(route.ruleId),
            path: getVercelEgressDemandMarkerPath(route.ruleId),
          },
        ]);
        return new Response("Sandbox egress authorization required", { status: 428 });
      } catch (error) {
        const errorId = logError(log, "sandbox egress proxy failed", error, {
          ruleId: route.ruleId,
          sandboxId: meta.sandboxId,
          sandboxName: route.sandboxName,
          stage,
        });
        return Response.json(
          { error: "Sandbox egress proxy failed.", errorId, stage },
          { status: 500 },
        );
      }
    },
    () => new Response("Forbidden", { status: 403 }),
  );
  return await handleProxyRequest(event.req);
}

function readRoute(
  url: string,
): { readonly ruleId: string; readonly sandboxName: string } | undefined {
  const pathname = new URL(url).pathname;
  if (!pathname.startsWith(EGRESS_ROUTE_PREFIX)) return undefined;
  const [ruleId, encodedSandboxName] = pathname.slice(EGRESS_ROUTE_PREFIX.length).split("/");
  if (ruleId === undefined || !/^r\d+-\d+$/.test(ruleId) || encodedSandboxName === undefined) {
    return undefined;
  }
  try {
    const sandboxName = decodeURIComponent(encodedSandboxName);
    if (sandboxName.length === 0 || sandboxName.includes("/") || sandboxName.includes("\0")) {
      return undefined;
    }
    return { ruleId, sandboxName };
  } catch {
    return undefined;
  }
}
