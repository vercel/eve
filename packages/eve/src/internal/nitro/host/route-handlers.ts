import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import {
  resolvePackageDependencyPath,
  resolvePackageSourceFilePath,
} from "#internal/application/package.js";
import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";

function importSourceModule(relativeSourcePath: string): string {
  return stringifyEsmImportSpecifier(resolvePackageSourceFilePath(relativeSourcePath));
}

function importNitroModule(specifier: "nitro" | "nitro/h3"): string {
  return stringifyEsmImportSpecifier(resolvePackageDependencyPath(specifier));
}

/** Statements that run first in a GET handler whose path has no HEAD route. */
function headGuard(allow: readonly string[] | undefined): {
  readonly imports: readonly string[];
  readonly statements: readonly string[];
} {
  if (allow === undefined) return { imports: [], statements: [] };
  return {
    imports: [
      `import { rejectHeadRequest } from ${importSourceModule("src/internal/nitro/routes/method-guard.ts")};`,
    ],
    statements: [`  rejectHeadRequest(event, ${JSON.stringify(allow.join(", "))});`],
  };
}

/** A channel HTTP route: optional CORS and HEAD guard, then channel dispatch. */
export function renderChannelHandler(input: {
  readonly allow?: readonly string[];
  readonly artifactsConfig: NitroArtifactsConfig;
  readonly cors?: NormalizedChannelCorsOptions;
  readonly routeKey: string;
}): string {
  const guard = headGuard(input.allow);
  const dispatch = `dispatchChannelRequest(event, ${JSON.stringify(input.routeKey)}, config)`;
  // CORS runs first so a cross-origin caller can read the guard's 405.
  const body = [
    ...(input.cors === undefined
      ? []
      : [
          `  const corsResponse = handleCors(event, cors);`,
          `  if (corsResponse !== false) return corsResponse;`,
        ]),
    ...guard.statements,
  ];
  return [
    ...guard.imports,
    ...(input.cors === undefined
      ? []
      : [
          `import { handleCors } from ${importNitroModule("nitro/h3")};`,
          `const cors = ${JSON.stringify(input.cors)};`,
        ]),
    `import { dispatchChannelRequest } from ${importSourceModule("src/internal/nitro/routes/channel-dispatch.ts")};`,
    `const config = ${JSON.stringify(input.artifactsConfig)};`,
    body.length === 0
      ? `export default (event) => ${dispatch};`
      : [`export default (event) => {`, ...body, `  return ${dispatch};`, `};`].join("\n"),
  ].join("\n");
}

/** The preflight answer for a CORS-enabled channel path. */
export function renderChannelPreflightHandler(input: {
  readonly cors: NormalizedChannelCorsOptions;
}): string {
  return [
    `import { handleCors } from ${importNitroModule("nitro/h3")};`,
    `const cors = ${JSON.stringify(input.cors)};`,
    `export default (event) => {`,
    `  const corsResponse = handleCors(event, cors);`,
    `  if (corsResponse !== false) return corsResponse;`,
    `  return new Response(null, { status: 204 });`,
    `};`,
  ].join("\n");
}

export function renderChannelWebSocketHandler(input: {
  readonly artifactsConfig: NitroArtifactsConfig;
  readonly routeKey: string;
}): string {
  return [
    `import { defineWebSocketHandler } from ${importNitroModule("nitro")};`,
    `import { dispatchChannelWebSocketRequest } from ${importSourceModule("src/internal/nitro/routes/channel-dispatch.ts")};`,
    `const config = ${JSON.stringify(input.artifactsConfig)};`,
    `export default defineWebSocketHandler((event) => dispatchChannelWebSocketRequest(event, ${JSON.stringify(input.routeKey)}, config));`,
  ].join("\n");
}

/**
 * A framework route whose build-time arguments are baked in. The handler
 * receives them plus the request, so it can still authenticate per request.
 */
export function renderHostHandler(input: {
  readonly args: unknown;
  readonly handlerExport: string;
  readonly modulePath: string;
}): string {
  return [
    `import { ${input.handlerExport} } from ${importSourceModule(input.modulePath)};`,
    `export default async (event) => ${input.handlerExport}(${JSON.stringify(input.args)}, event.req);`,
  ].join("\n");
}

/**
 * Nitro task modules default-export an object with `run`. Importing
 * `defineTask` from `"nitro/task"` would fail on Vercel, where `nitro` is a
 * build-only dependency outside the function trace.
 */
export function renderScheduleTaskModule(input: {
  readonly artifactsConfig: NitroArtifactsConfig;
  readonly description: string;
}): string {
  return [
    `import { dispatchScheduleTask } from ${importSourceModule("src/internal/nitro/routes/schedule-task.ts")};`,
    `const config = ${JSON.stringify(input.artifactsConfig)};`,
    `export default {`,
    `  meta: { description: ${JSON.stringify(input.description)} },`,
    `  async run(event) {`,
    `    return { result: await dispatchScheduleTask(event.name, config) };`,
    `  },`,
    `};`,
  ].join("\n");
}

/**
 * The physical handler beside the workflow bundle. It re-exports the bundle's
 * `POST` as the route handler and, for a direct queue, registers that `POST`
 * on the workflow world at module load so the first queue dispatch on this
 * worker skips the HTTP loopback. It stays a file, not a virtual module:
 * Nitro virtuals default to `moduleSideEffects: false`, which would drop that
 * registration.
 */
export function renderWorkflowFileHandler(input: {
  readonly direct?: {
    readonly queuePrefix: string;
    readonly runtimeImportSpecifier: string;
    readonly workflowWorldPluginImportSpecifier?: string;
  };
  readonly workflowsImportSpecifier: string;
}): string {
  const lines: string[] = [
    "// Generated by eve. Do not edit by hand.",
    `import { POST } from ${JSON.stringify(input.workflowsImportSpecifier)};`,
  ];

  if (input.direct !== undefined) {
    if (input.direct.workflowWorldPluginImportSpecifier !== undefined) {
      lines.push(`import ${JSON.stringify(input.direct.workflowWorldPluginImportSpecifier)};`);
    }
    lines.push(
      `import { getWorld as __eveGetWorkflowWorld } from ${JSON.stringify(input.direct.runtimeImportSpecifier)};`,
      "",
      "try {",
      "  const __eveWorkflowWorld = await __eveGetWorkflowWorld();",
      '  if (typeof __eveWorkflowWorld?.registerHandler === "function") {',
      `    __eveWorkflowWorld.registerHandler(${JSON.stringify(input.direct.queuePrefix)}, POST);`,
      "  }",
      "} catch (err) {",
      '  console.warn("[eve] Failed to register direct workflow queue handlers:", err);',
      "}",
    );
  }

  lines.push("", "export default async ({ req }) => {", "  return await POST(req);", "};", "");
  return lines.join("\n");
}
