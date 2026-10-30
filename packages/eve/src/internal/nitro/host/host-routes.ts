import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { NitroEventHandler } from "nitro/types";

import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import { normalizeRoutePattern } from "#compiler/channel-route-plan.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import { EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN, EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { connectionEventRoute } from "#runtime/connections/events/path.js";
import type { ScheduleRegistration } from "#runtime/schedules/register.js";
import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
import { resolveWorkflowModulePath } from "#internal/application/package.js";
import {
  renderChannelHandler,
  renderChannelPreflightHandler,
  renderChannelWebSocketHandler,
  renderHostHandler,
  renderRouteConfigModule,
  renderScheduleTaskModule,
  renderWorkflowFileHandler,
  ROUTE_CONFIG_ID,
} from "#internal/nitro/host/route-handlers.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import {
  EVE_SCHEDULE_COLLECTION_CONSUMER_ROUTE_PATH,
  hasVercelScheduleCollections,
} from "#internal/schedules/consumer-route.js";
import type { WorkflowArtifacts } from "#internal/workflow-bundle/builder.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#internal/workflow-bundle/eve-service-route-output.js";
import { usesParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-protocol.js";
import { deriveEveWorkflowQueuePrefix } from "#internal/workflow/queue-namespace.js";

/** The dedicated Vercel function a route needs instead of the shared server function. */
export type HostRouteVercelFunction = "schedule-queue" | "workflow-queue";

type HostRoute =
  | {
      readonly kind: "channel";
      readonly method: ChannelRouteMethod;
      readonly path: string;
      readonly cors?: NormalizedChannelCorsOptions;
      /**
       * Set on a GET route whose path has no HEAD route: every method declared
       * for the path. The route answers HEAD with 405 and this `Allow` set.
       */
      readonly allow?: readonly string[];
    }
  | {
      readonly kind: "channel-preflight";
      readonly method: "OPTIONS";
      readonly path: string;
      readonly cors: NormalizedChannelCorsOptions;
    }
  | {
      readonly kind: "connection-event";
      readonly method: "POST";
      readonly path: string;
      readonly connectionName: string;
    }
  | { readonly kind: "development-schedule"; readonly method: "POST"; readonly path: string }
  | {
      readonly kind: "schedule-consumer";
      readonly method: "POST";
      readonly path: string;
      readonly vercelFunction: "schedule-queue";
    }
  | {
      readonly kind: "workflow";
      readonly method: "ALL";
      readonly path: string;
      /** Registers the bundle's `POST` on the worker's own world queue. */
      readonly directQueuePrefix?: string;
      readonly vercelFunction: "workflow-queue";
    };

export interface HostRouteTable {
  readonly routes: readonly HostRoute[];
  readonly scheduleTasks: readonly ScheduleRegistration[];
  /** The Vercel cron path; the Vercel preset registers its handler. */
  readonly cronHandlerRoute?: string;
}

interface HostRouteTableInput {
  readonly manifest: Pick<CompiledAgentManifest, "channelRoutes" | "config"> &
    Partial<Pick<CompiledAgentManifest, "connections" | "scheduleCollections">>;
  readonly mode: "development" | "production";
  readonly scheduleRegistrations: readonly ScheduleRegistration[];
  readonly vercel: boolean;
}

/** Every route, task, and cron path eve's Nitro host serves, in registration order. */
export function createHostRouteTable(input: HostRouteTableInput): HostRouteTable {
  const { manifest } = input;
  const development = input.mode === "development";
  const routes: HostRoute[] = [
    ...manifest.channelRoutes.effective.map((route): HostRoute => ({
      cors: route.cors,
      kind: "channel",
      method: route.method,
      path: route.urlPath,
    })),
    ...manifest.channelRoutes.preflight.map((route): HostRoute => ({
      cors: route.cors,
      kind: "channel-preflight",
      method: "OPTIONS",
      path: route.urlPath,
    })),
  ];
  for (const connection of manifest.connections ?? []) {
    if (connection.experimental_events !== true) continue;
    const path = connectionEventRoute(connection.connectionName);
    if (routes.some((route) => route.path === path))
      throw new Error(`Connection event receiver conflicts with an existing route: ${path}`);
    routes.push({
      kind: "connection-event",
      method: "POST",
      path,
      connectionName: connection.connectionName,
    });
  }
  if (development) {
    routes.push({
      kind: "development-schedule",
      method: "POST",
      path: EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
    });
  }
  if (!development && input.vercel && hasVercelScheduleCollections(manifest)) {
    routes.push({
      kind: "schedule-consumer",
      method: "POST",
      path: EVE_SCHEDULE_COLLECTION_CONSUMER_ROUTE_PATH,
      vercelFunction: "schedule-queue",
    });
  }
  routes.push({
    kind: "workflow",
    method: "ALL",
    path: EVE_WORKFLOW_FLOW_ROUTE_PATH,
    vercelFunction: "workflow-queue",
    ...(hasDirectWorkflowQueue(input) && {
      directQueuePrefix: deriveEveWorkflowQueuePrefix(manifest.config.name),
    }),
  });

  const scheduleTasks = development ? [] : input.scheduleRegistrations;
  return {
    routes: routes.map((route) => withHeadAllow(route, routes)),
    scheduleTasks,
    ...(scheduleTasks.length > 0 && input.vercel && { cronHandlerRoute: createCronHandlerRoute() }),
  };
}

/**
 * Dev queues dispatch in the worker unless the parent owns the World. Hosted
 * Vercel builds deliver through queue functions, so only a self-hosted build
 * with a configured World dispatches in process.
 */
function hasDirectWorkflowQueue(input: HostRouteTableInput): boolean {
  const configuredWorld = input.manifest.config.experimental?.workflow?.world;
  return input.mode === "development"
    ? !usesParentDevelopmentWorkflowWorld(configuredWorld)
    : !input.vercel && configuredWorld !== undefined;
}

function withHeadAllow(route: HostRoute, routes: readonly HostRoute[]): HostRoute {
  if (route.kind !== "channel" || route.method !== "GET") return route;
  // Match as the router does: parameter names don't distinguish paths.
  const pattern = normalizeRoutePattern(route.path);
  const methods = routes
    .filter((candidate) => normalizeRoutePattern(candidate.path) === pattern)
    .map((candidate) => candidate.method)
    .filter((method) => method !== "WEBSOCKET" && method !== "ALL");
  if (methods.includes("HEAD")) return route;
  return { ...route, allow: [...new Set(methods)] };
}

/**
 * An unguessable cron path under eve's protocol prefix. Vercel cron requests
 * otherwise hit the public `/_vercel/cron` and rely on a `CRON_SECRET` the
 * user must set; the path itself is the secret here. Vercel reads it from the
 * deployment's `config.crons[]`, and it is never logged or served.
 */
function createCronHandlerRoute(): string {
  return `${EVE_ROUTE_PREFIX}/cron/${randomBytes(32).toString("base64url")}`;
}

export interface HostNitroRoutes {
  readonly experimental?: { readonly tasks: true };
  readonly handlers: NitroEventHandler[];
  readonly scheduledTasks: Record<string, string | string[]>;
  readonly tasks: Record<string, { readonly description: string; readonly handler: string }>;
  readonly virtual: Record<string, string>;
}

/**
 * Renders the route table into Nitro config. Writes the artifacts config every
 * route module shares to `artifactsConfigPath` and the workflow handler file
 * beside the workflow bundle; everything else is a virtual module.
 */
export async function renderHostRoutes(
  table: HostRouteTable,
  input: {
    readonly artifactsConfig: NitroArtifactsConfig;
    readonly artifactsConfigPath: string;
    readonly workflowArtifacts: WorkflowArtifacts;
    readonly workflowWorldPluginPath?: string;
  },
): Promise<HostNitroRoutes> {
  await mkdir(dirname(input.artifactsConfigPath), { recursive: true });
  await writeFile(input.artifactsConfigPath, JSON.stringify(input.artifactsConfig));
  const handlers: NitroEventHandler[] = [];
  const virtual: Record<string, string> = {
    [ROUTE_CONFIG_ID]: renderRouteConfigModule({ configPath: input.artifactsConfigPath }),
  };
  const addVirtualHandler = (
    id: string,
    source: string,
    registration: Omit<NitroEventHandler, "handler">,
  ) => {
    virtual[id] = source;
    handlers.push({ handler: id, ...registration });
  };

  // A WebSocket upgrade arrives as a GET, so a path with both routes gets one
  // GET handler that serves HTTP requests and answers upgrades. Paths match
  // as the router matches them: parameter names don't distinguish them.
  const channelRoutes = table.routes.filter((route) => route.kind === "channel");
  const httpGetPatterns = new Set(
    channelRoutes
      .filter((route) => route.method === "GET")
      .map((route) => normalizeRoutePattern(route.path)),
  );
  const websocketRouteKeys = new Map(
    channelRoutes
      .filter((route) => route.method === "WEBSOCKET")
      .map((route) => [normalizeRoutePattern(route.path), `WEBSOCKET ${route.path}`]),
  );

  for (const route of table.routes) {
    switch (route.kind) {
      case "channel": {
        const routeKey = `${route.method} ${route.path}`;
        const id = `#eve/channel/${routeKey}`;
        const pattern = normalizeRoutePattern(route.path);
        if (route.method === "WEBSOCKET") {
          if (!httpGetPatterns.has(pattern)) {
            addVirtualHandler(id, renderChannelWebSocketHandler({ routeKey }), {
              method: "GET",
              route: route.path,
            });
          }
          break;
        }
        const websocketRouteKey =
          route.method === "GET" ? websocketRouteKeys.get(pattern) : undefined;
        addVirtualHandler(
          id,
          renderChannelHandler({
            allow: route.allow,
            cors: route.cors,
            routeKey,
            ...(websocketRouteKey !== undefined && { websocketRouteKey }),
          }),
          { method: route.method, route: route.path },
        );
        // The beta router sends HEAD only to HEAD handlers, so the guard needs
        // its own registration. Redundant once Nitro serves HEAD from GET routes.
        if (route.allow !== undefined) {
          handlers.push({ handler: id, method: "HEAD", route: route.path });
        }
        break;
      }
      case "channel-preflight":
        addVirtualHandler(
          `#eve/channel/OPTIONS ${route.path}`,
          renderChannelPreflightHandler({ cors: route.cors }),
          { method: "OPTIONS", route: route.path },
        );
        break;
      case "connection-event":
        addVirtualHandler(
          `#eve/route${route.path}`,
          renderHostHandler({
            context: { connectionName: route.connectionName },
            handlerExport: "handleConnectionEventRequest",
            modulePath: "src/internal/nitro/routes/connection-events.ts",
          }),
          { method: route.method, route: route.path },
        );
        break;
      case "development-schedule":
        // Resolved here, in the unbundled host process: resolving the
        // module-map loader from inside the bundled dev server can land on the
        // authored app instead of the installed eve package (vercel/eve#311).
        addVirtualHandler(
          `#eve/route${route.path}`,
          renderHostHandler({
            handlerExport: "handleDevScheduleDispatchRequest",
            modulePath: "src/internal/nitro/routes/dev-schedule-dispatch.ts",
          }),
          { method: route.method, route: route.path },
        );
        break;
      case "schedule-consumer":
        addVirtualHandler(
          `#eve/route${route.path}`,
          renderHostHandler({
            handlerExport: "handleScheduleCollectionConsumer",
            modulePath: "src/internal/nitro/routes/schedule-collection-consumer.ts",
          }),
          { method: route.method, route: route.path },
        );
        break;
      case "workflow":
        handlers.push({
          handler: await writeWorkflowFileHandler(route, input),
          route: route.path,
        });
        break;
    }
  }

  const tasks: HostNitroRoutes["tasks"] = {};
  const scheduledTasks: Record<string, string[]> = {};
  for (const task of table.scheduleTasks) {
    const id = `#eve/schedule-task/${task.taskName}`;
    virtual[id] = renderScheduleTaskModule({ description: task.description });
    tasks[task.taskName] = { description: task.description, handler: id };
    const cronTasks = (scheduledTasks[task.cron] ??= []);
    if (!cronTasks.includes(task.taskName)) cronTasks.push(task.taskName);
  }

  return {
    handlers,
    scheduledTasks: Object.fromEntries(
      Object.entries(scheduledTasks).map(([cron, names]) => [
        cron,
        names.length === 1 ? names[0]! : names,
      ]),
    ),
    tasks,
    virtual,
    ...(table.scheduleTasks.length > 0 && { experimental: { tasks: true } }),
  };
}

/**
 * The workflow route's handler file, written beside the bundle. It stays a
 * file because it registers queue handlers as top-level side effects, and
 * Nitro virtual modules default to `moduleSideEffects: false`.
 */
export function workflowHandlerPath(workflowArtifacts: WorkflowArtifacts): string {
  return join(dirname(workflowArtifacts.workflowsPath), "workflows-handler.mjs");
}

async function writeWorkflowFileHandler(
  route: Extract<HostRoute, { kind: "workflow" }>,
  input: {
    readonly workflowArtifacts: WorkflowArtifacts;
    readonly workflowWorldPluginPath?: string;
  },
): Promise<string> {
  const directory = dirname(input.workflowArtifacts.workflowsPath);
  const handlerPath = workflowHandlerPath(input.workflowArtifacts);
  await writeFile(
    handlerPath,
    renderWorkflowFileHandler({
      direct:
        route.directQueuePrefix === undefined
          ? undefined
          : {
              queuePrefix: route.directQueuePrefix,
              runtimeImportSpecifier: normalizeEsmImportSpecifier(
                resolveWorkflowModulePath("workflow/runtime"),
              ),
              workflowWorldPluginImportSpecifier:
                input.workflowWorldPluginPath === undefined
                  ? undefined
                  : relativeImportSpecifier(directory, input.workflowWorldPluginPath),
            },
      workflowsImportSpecifier: relativeImportSpecifier(
        directory,
        input.workflowArtifacts.workflowsPath,
      ),
    }),
  );
  return handlerPath;
}

function relativeImportSpecifier(fromDirectory: string, targetPath: string): string {
  const relativePath = relative(fromDirectory, targetPath).replaceAll("\\", "/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}
