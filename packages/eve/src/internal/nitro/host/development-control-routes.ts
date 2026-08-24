import type { AuthoredSourceWatcherHandle } from "#internal/nitro/host/dev-authored-source-watcher.js";
import { handleDevRuntimeArtifactsRequest } from "#internal/nitro/routes/dev-runtime-artifacts.js";
import type { ParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-server.js";
import {
  matchHostRouteRegistration,
  type HostRouteIdForMount,
} from "#protocol/host-route-inventory.js";

interface DevelopmentControlRouteInput {
  readonly appRoot: string;
  readonly getReadyServerId: () => string | undefined;
  readonly getWatcher: () => AuthoredSourceWatcherHandle | undefined;
  readonly workflowWorld: ParentDevelopmentWorkflowWorld | undefined;
}

interface DevelopmentControlRouteHandlerInput extends DevelopmentControlRouteInput {
  readonly request: Request;
  readonly url: URL;
}

type DevelopmentControlRouteHandler = (
  input: DevelopmentControlRouteHandlerInput,
) => Promise<Response | undefined>;

const DEVELOPMENT_CONTROL_ROUTE_HANDLERS = {
  "development-artifacts": async (input) => createRuntimeArtifactsResponse(input),
  "development-artifacts-rebuild": async (input) => {
    const watcher = input.getWatcher();
    if (watcher === undefined) return createStartingResponse();
    if (input.url.searchParams.get("force") === "1") {
      await watcher.rebuild();
    } else {
      await watcher.flush();
    }
    return createRuntimeArtifactsResponse(input);
  },
  "development-artifacts-resume": async (input) => {
    const watcher = input.getWatcher();
    if (watcher === undefined) return createStartingResponse();
    await watcher.resume({ silent: input.url.searchParams.get("silent") === "1" });
    return createRuntimeArtifactsResponse(input);
  },
  "development-artifacts-suspend": async (input) => {
    const watcher = input.getWatcher();
    if (watcher === undefined) return createStartingResponse();
    await watcher.suspend();
    return Response.json({ suspended: true });
  },
  "development-workflow-stream": async (input) =>
    await input.workflowWorld?.handleRequest(input.request),
  "development-workflow-world": async (input) =>
    await input.workflowWorld?.handleRequest(input.request),
} satisfies Record<HostRouteIdForMount<"development-control">, DevelopmentControlRouteHandler>;

/** Dispatches one parent-owned dev route selected from the protocol inventory. */
export async function handleDevelopmentControlRoute(
  input: DevelopmentControlRouteInput,
  request: Request,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const registration = matchHostRouteRegistration({
    method: request.method,
    mount: "development-control",
    pathname: url.pathname,
  });
  if (registration === undefined) return undefined;

  return await DEVELOPMENT_CONTROL_ROUTE_HANDLERS[registration.id]({ ...input, request, url });
}

function createRuntimeArtifactsResponse(input: DevelopmentControlRouteInput): Response {
  return handleDevRuntimeArtifactsRequest({
    appRoot: input.appRoot,
    serverId: input.getReadyServerId(),
  });
}

function createStartingResponse(): Response {
  return Response.json({ error: "The development server is still starting." }, { status: 503 });
}
