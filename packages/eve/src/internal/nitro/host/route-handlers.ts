import {
  stringifyEsmImportSpecifier,
  stringifyNitroDataImportSpecifier,
} from "#internal/application/import-specifier.js";
import {
  resolvePackageDependencyPath,
  resolvePackageSourceFilePath,
} from "#internal/application/package.js";
import type { NormalizedChannelCorsOptions } from "#channel/cors.js";

function importSourceModule(relativeSourcePath: string): string {
  return stringifyEsmImportSpecifier(resolvePackageSourceFilePath(relativeSourcePath));
}

function importNitroModule(specifier: "nitro" | "nitro/h3"): string {
  return stringifyEsmImportSpecifier(resolvePackageDependencyPath(specifier));
}

export const ROUTE_CONFIG_ID = "#eve/route-config";

const importRouteConfig = `import config from ${JSON.stringify(ROUTE_CONFIG_ID)};`;

export function renderRouteConfigModule(input: { readonly configPath: string }): string {
  return [
    `import data from ${stringifyNitroDataImportSpecifier("text", input.configPath)};`,
    "export default JSON.parse(data);",
  ].join("\n");
}

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

export function renderChannelHandler(input: {
  readonly allow?: readonly string[];
  readonly cors?: NormalizedChannelCorsOptions;
  readonly routeKey: string;
  readonly websocketRouteKey?: string;
}): string {
  const guard = headGuard(input.allow);
  const dispatch = `dispatchChannelRequest(event, ${JSON.stringify(input.routeKey)}, config)`;
  const body = [
    ...(input.cors === undefined
      ? []
      : [
          `  const corsResponse = handleCors(event, cors);`,
          `  if (corsResponse !== false) return corsResponse;`,
        ]),
    ...guard.statements,
  ];
  const handler =
    body.length === 0
      ? `(event) => ${dispatch}`
      : [`(event) => {`, ...body, `  return ${dispatch};`, `}`].join("\n");
  return [
    ...guard.imports,
    ...(input.cors === undefined
      ? []
      : [
          `import { handleCors } from ${importNitroModule("nitro/h3")};`,
          `const cors = ${JSON.stringify(input.cors)};`,
        ]),
    ...(input.websocketRouteKey === undefined
      ? [
          `import { dispatchChannelRequest } from ${importSourceModule("src/internal/nitro/routes/channel-dispatch.ts")};`,
        ]
      : [
          `import { defineWebSocketHandler } from ${importNitroModule("nitro")};`,
          `import { dispatchChannelRequest, dispatchChannelWebSocketRequest } from ${importSourceModule("src/internal/nitro/routes/channel-dispatch.ts")};`,
        ]),
    importRouteConfig,
    input.websocketRouteKey === undefined
      ? `export default ${handler};`
      : `export default defineWebSocketHandler((event) => dispatchChannelWebSocketRequest(event, ${JSON.stringify(input.websocketRouteKey)}, config), ${handler});`,
  ].join("\n");
}

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
  readonly allow?: readonly string[];
  readonly routeKey: string;
}): string {
  const guard = headGuard(input.allow);
  const dispatch = `dispatchChannelWebSocketRequest(event, ${JSON.stringify(input.routeKey)}, config)`;
  const hooks =
    guard.statements.length === 0
      ? `(event) => ${dispatch}`
      : [`(event) => {`, ...guard.statements, `  return ${dispatch};`, `}`].join("\n");
  return [
    ...guard.imports,
    `import { defineWebSocketHandler } from ${importNitroModule("nitro")};`,
    `import { dispatchChannelWebSocketRequest } from ${importSourceModule("src/internal/nitro/routes/channel-dispatch.ts")};`,
    importRouteConfig,
    `export default defineWebSocketHandler(${hooks});`,
  ].join("\n");
}

export function renderHostHandler(input: {
  readonly context?: Readonly<Record<string, string>>;
  readonly handlerExport: string;
  readonly modulePath: string;
}): string {
  const args =
    input.context === undefined
      ? "config"
      : `{ artifactsConfig: config, ...${JSON.stringify(input.context)} }`;
  return [
    `import { ${input.handlerExport} } from ${importSourceModule(input.modulePath)};`,
    importRouteConfig,
    `export default async (event) => ${input.handlerExport}(${args}, event.req);`,
  ].join("\n");
}

export function renderScheduleTaskModule(input: {
  readonly description: string;
  readonly taskName: string;
}): string {
  return [
    `import { dispatchScheduleTask } from ${importSourceModule("src/internal/nitro/routes/schedule-task.ts")};`,
    importRouteConfig,
    `export default {`,
    `  meta: { description: ${JSON.stringify(input.description)} },`,
    `  async run(event) {`,
    `    return { result: await dispatchScheduleTask(${JSON.stringify(input.taskName)}, config) };`,
    `  },`,
    `};`,
  ].join("\n");
}

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
