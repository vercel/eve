import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { H3 } from "nitro/h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CompiledAgentManifest, CompiledChannelDefinition } from "#compiler/manifest.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import { EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN } from "#protocol/routes.js";
import type { ScheduleRegistration } from "#runtime/schedules/register.js";
import { resolveWorkflowModulePath } from "#internal/application/package.js";
import { createDevelopmentNitroArtifactsConfig } from "#internal/nitro/host/artifacts-config.js";
import { createHostRouteTable, renderHostRoutes } from "#internal/nitro/host/host-routes.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#internal/workflow-bundle/eve-service-route-output.js";

const routeModules = vi.hoisted(() => ({
  dispatchChannelRequest: vi.fn(
    async (_event: unknown, routeKey: string) => new Response(`channel ${routeKey}`),
  ),
  dispatchScheduleTask: vi.fn(async (name: string) => `ran ${name}`),
  handleConnectionEventRequest: vi.fn(async () => new Response("connection")),
  handleDevScheduleDispatchRequest: vi.fn(async () => new Response("dev schedule")),
}));

vi.mock("#internal/nitro/routes/channel-dispatch.js", () => ({
  dispatchChannelRequest: routeModules.dispatchChannelRequest,
  dispatchChannelWebSocketRequest: vi.fn(),
}));
vi.mock("#internal/nitro/routes/connection-events.js", () => ({
  handleConnectionEventRequest: routeModules.handleConnectionEventRequest,
}));
vi.mock("#internal/nitro/routes/dev-schedule-dispatch.js", () => ({
  handleDevScheduleDispatchRequest: routeModules.handleDevScheduleDispatchRequest,
}));
vi.mock("#internal/nitro/routes/schedule-task.js", () => ({
  dispatchScheduleTask: routeModules.dispatchScheduleTask,
}));

const createDirectory = useTemporaryDirectories();
const artifactsConfig = createDevelopmentNitroArtifactsConfig({ appRoot: "/app" });

function channel(method: ChannelRouteMethod, urlPath: string): CompiledChannelDefinition {
  return {
    kind: "channel",
    logicalPath: "channels/probe.ts",
    method,
    name: "probe",
    sourceId: "app:probe",
    sourceKind: "module",
    urlPath,
  };
}

function schedule(taskName: string, cron: string): ScheduleRegistration {
  return {
    cron,
    description: `Run ${taskName}.`,
    logicalPath: `schedules/${taskName}.md`,
    scheduleId: taskName,
    sourceId: `app:${taskName}`,
    taskName,
  };
}

function manifest(world?: string): Parameters<typeof createHostRouteTable>[0]["manifest"] {
  return {
    channelRoutes: {
      effective: [
        channel("GET", "/stream"),
        channel("POST", "/stream"),
        channel("GET", "/health"),
        channel("HEAD", "/health"),
        channel("WEBSOCKET", "/voice"),
      ],
      preflight: [{ cors: {}, method: "OPTIONS", sourceIds: ["app:probe"], urlPath: "/stream" }],
      shadowed: [],
    },
    config: {
      name: "probe-agent",
      ...(world !== undefined && { experimental: { workflow: { world } } }),
    } as CompiledAgentManifest["config"],
    connections: [
      { connectionName: "issues", experimental_events: true },
    ] as CompiledAgentManifest["connections"],
  };
}

/** Serves the rendered routes the way Nitro does: an h3 app over the loaded handler modules. */
async function serve(input: {
  readonly mode: "development" | "production";
  readonly scheduleRegistrations?: readonly ScheduleRegistration[];
  readonly world?: string;
}) {
  const directory = await createDirectory("eve-host-routes-");
  const workflowsPath = join(directory, "workflows.mjs");
  const workflowWorldPluginPath = join(directory, "workflow-world.mjs");
  await writeFile(
    workflowsPath,
    "export async function POST(request) { return new Response(`flow ${request.method}`); }\n",
  );
  await writeFile(workflowWorldPluginPath, "export default function plugin() {}\n");

  const routes = await renderHostRoutes(
    createHostRouteTable({
      manifest: manifest(input.world),
      mode: input.mode,
      scheduleRegistrations: input.scheduleRegistrations ?? [],
      vercel: false,
    }),
    {
      artifactsConfig,
      workflowArtifacts: {
        stepTargets: [],
        stepsPath: join(directory, "steps.mjs"),
        workflowsPath,
      },
      workflowWorldPluginPath,
    },
  );

  const modules = new Map<string, { default: unknown }>();
  for (const [index, [id, source]] of Object.entries(routes.virtual).entries()) {
    const file = join(directory, `virtual-${index}.mjs`);
    await writeFile(file, source);
    modules.set(id, await import(pathToFileURL(file).href));
  }
  const load = async (handler: string) =>
    (modules.get(handler) ?? (await import(pathToFileURL(handler).href))).default;

  const app = new H3();
  for (const entry of routes.handlers) {
    const handler = (await load(entry.handler)) as Parameters<H3["all"]>[1];
    if (entry.method === undefined) app.all(entry.route, handler);
    else app.on(entry.method, entry.route, handler);
  }
  return {
    fetch: (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://localhost${path}`, init)),
    load,
    routes,
  };
}

describe("rendered host routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers each channel route by method", async () => {
    const { routes } = await serve({ mode: "production" });
    const methodsAt = (route: string) =>
      routes.handlers.filter((entry) => entry.route === route).map((entry) => entry.method);
    const handlerAt = (route: string, method: string) =>
      routes.handlers.find((entry) => entry.route === route && entry.method === method)?.handler;

    expect(methodsAt("/stream")).toEqual(["GET", "POST", "OPTIONS"]);
    expect(methodsAt("/health")).toEqual(["GET", "HEAD"]);
    expect(handlerAt("/health", "HEAD")).not.toBe(handlerAt("/health", "GET"));
    // WebSocket upgrades arrive as GET, so the route accepts every method.
    expect(methodsAt("/voice")).toEqual([undefined]);
  });

  it("answers CORS preflights without dispatching to the channel", async () => {
    const host = await serve({ mode: "production" });

    const preflight = await host.fetch("/stream", {
      headers: { "access-control-request-method": "POST", origin: "https://app.example" },
      method: "OPTIONS",
    });

    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get("access-control-allow-origin")).not.toBeNull();
    expect(routeModules.dispatchChannelRequest).not.toHaveBeenCalled();
  });

  it("passes baked build-time arguments to host routes", async () => {
    const host = await serve({ mode: "development" });

    expect(await (await host.fetch("/eve/v1/hooks/issues", { method: "POST" })).text()).toBe(
      "connection",
    );
    expect(routeModules.handleConnectionEventRequest).toHaveBeenCalledWith(
      { artifactsConfig, connectionName: "issues" },
      expect.any(Request),
    );

    const devSchedulePath = EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN.replace(/:[^/]+/g, "daily");
    expect(await (await host.fetch(devSchedulePath, { method: "POST" })).text()).toBe(
      "dev schedule",
    );
    expect(routeModules.handleDevScheduleDispatchRequest).toHaveBeenCalledWith(
      artifactsConfig,
      expect.any(Request),
    );
  });

  it("serves the workflow route from the bundle beside its handler for every method", async () => {
    const host = await serve({ mode: "production" });

    for (const method of ["GET", "POST"]) {
      const response = await host.fetch(EVE_WORKFLOW_FLOW_ROUTE_PATH, { method });
      expect(await response.text()).toBe(`flow ${method}`);
    }
  });

  it.each([
    { world: undefined, registered: false },
    { world: "@workflow/world-postgres", registered: true },
  ])(
    "registers the dev workflow bundle on the worker's own queue: $registered",
    async ({ registered, world }) => {
      const registerHandler = vi.fn();
      vi.doMock(resolveWorkflowModulePath("workflow/runtime"), () => ({
        getWorld: async () => ({ registerHandler }),
      }));
      const host = await serve({ mode: "development", world });

      await host.load(
        host.routes.handlers.find((entry) => entry.route === EVE_WORKFLOW_FLOW_ROUTE_PATH)!.handler,
      );

      expect(registerHandler.mock.calls.map(([prefix]) => prefix)).toEqual(
        registered ? ["__eve70726f62652d6167656e74_wkf_workflow_"] : [],
      );
    },
  );

  it("schedules production tasks by cron and runs them through the schedule dispatcher", async () => {
    const host = await serve({
      mode: "production",
      scheduleRegistrations: [
        schedule("daily", "0 0 * * *"),
        schedule("digest", "0 0 * * *"),
        schedule("weekly", "0 0 * * 0"),
      ],
    });

    expect(host.routes.experimental).toEqual({ tasks: true });
    expect(host.routes.scheduledTasks).toEqual({
      "0 0 * * *": ["daily", "digest"],
      "0 0 * * 0": "weekly",
    });
    const task = (await host.load(host.routes.tasks.daily!.handler)) as {
      run(event: { name: string }): Promise<unknown>;
    };
    expect(await task.run({ name: "daily" })).toEqual({ result: "ran daily" });
    expect(routeModules.dispatchScheduleTask).toHaveBeenCalledWith("daily", artifactsConfig);
  });
});
