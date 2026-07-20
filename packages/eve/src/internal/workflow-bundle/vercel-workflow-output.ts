import {
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

import { buildSingleRolldownChunk } from "#internal/bundler/nitro-rolldown.js";
import {
  EVE_SHARED_SERVER_FUNCTION_PATH,
  isEveVercelFunctionPath,
  normalizeEveVercelRoutes,
} from "#internal/workflow-bundle/eve-service-route-output.js";

// just-bash and microsandbox are optional peer dependencies (the
// opt-in local sandbox engines) loaded lazily from the application's
// install; just-bash additionally exposes native optional codecs for
// xz/zstd support. All of these must stay external so workflow step
// bundles neither fail resolving an absent optional install nor try to
// inline platform-specific `.node` artifacts.
export const WORKFLOW_STEP_EXTERNAL_PACKAGES = [
  "@mongodb-js/zstd",
  "just-bash",
  "microsandbox",
  "node-liblzma",
] as const;

/**
 * Packages that must stay external during the initial workflow builder
 * pass so `node:*` transitive dependencies do not fail the workflow VM check.
 * Nitro performs the final bundling/tracing pass for hosted output.
 */
export const WORKFLOW_BUILDER_DEFERRED_PACKAGES = ["@chat-adapter/slack", "chat"] as const;

const WORKFLOW_FUNCTION_NODE_OPTIONS = "--experimental-require-module";

/**
 * Builds the environment block every generated Vercel workflow function needs.
 */
export function createWorkflowFunctionEnvironment(environment?: unknown): Record<string, unknown> {
  const nextEnvironment: Record<string, unknown> = {};

  if (isRecord(environment)) {
    Object.assign(nextEnvironment, environment);
  }

  nextEnvironment.NODE_OPTIONS = WORKFLOW_FUNCTION_NODE_OPTIONS;
  return nextEnvironment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Creates an empty staging directory for one emitted Vercel function.
 */
export async function prepareVercelFunctionDirectory(path: string): Promise<void> {
  await rm(path, {
    force: true,
    recursive: true,
  });
  await mkdir(path, { recursive: true });
}

async function resolveNitroFunctionDirectory(input: {
  fallbackPath: string;
  sourcePath: string;
}): Promise<string> {
  try {
    return await realpath(input.sourcePath);
  } catch {
    return await realpath(input.fallbackPath);
  }
}

/**
 * Copies a Nitro-bundled Vercel function directory into one standalone
 * workflow function directory.
 *
 * Nitro may emit route functions as symlinks back to `__server.func`. This
 * helper dereferences the source path first, then copies concrete files so the
 * generated workflow functions do not rely on symlinks.
 */
export async function copyNitroFunctionDirectory(input: {
  fallbackPath: string;
  sourcePath: string;
  targetPath: string;
}): Promise<void> {
  const sourcePath = await resolveNitroFunctionDirectory({
    fallbackPath: input.fallbackPath,
    sourcePath: input.sourcePath,
  });

  await prepareVercelFunctionDirectory(input.targetPath);
  await cp(sourcePath, input.targetPath, {
    dereference: true,
    recursive: true,
  });
}

/**
 * Keeps only eve-owned Vercel function output and rewrites eve route function
 * symlinks to a shared eve-owned server function.
 *
 * Nitro emits generic app routes such as `index.func -> ./__server.func` for
 * eve's standalone landing page. In a multi-service Next.js deployment those
 * root aliases collide with Next's own functions. The Next integration only
 * proxies eve's `/eve/v1/**` transport routes, so Vercel output should expose
 * those route functions and workflow trigger functions, not eve's root page.
 *
 * Nitro also dedupes every route function through `__server.func`. Preserve
 * that model by copying the shared target once into the eve-owned tree and
 * repointing eve route aliases at it before pruning the root target.
 */
export async function normalizeEveVercelFunctionOutput(
  outputDir: string,
  options: { readonly servicePrefix?: string } = {},
): Promise<void> {
  const functionsDir = join(outputDir, "functions");
  const sharedFunctionPath = await prepareSharedEveServerFunction(functionsDir);

  if (sharedFunctionPath !== null) {
    await repointEveFunctionSymlinksInDirectory(functionsDir, sharedFunctionPath);
  }
  await pruneNonEveFunctionEntries(functionsDir, functionsDir);
  await pruneNonEveVercelRoutes(outputDir, options.servicePrefix);
}

async function prepareSharedEveServerFunction(functionsDir: string): Promise<string | null> {
  const rootServerFunctionPath = join(functionsDir, "__server.func");
  const sharedFunctionPath = join(functionsDir, EVE_SHARED_SERVER_FUNCTION_PATH);
  let sourcePath: string;

  try {
    sourcePath = await realpath(rootServerFunctionPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const stagingPath = `${sharedFunctionPath}.eve-staging`;

  await mkdir(dirname(sharedFunctionPath), {
    recursive: true,
  });
  await rm(stagingPath, {
    force: true,
    recursive: true,
  });
  await cp(sourcePath, stagingPath, {
    dereference: true,
    recursive: true,
  });
  await rm(sharedFunctionPath, {
    force: true,
    recursive: true,
  });
  await rename(stagingPath, sharedFunctionPath);

  return sharedFunctionPath;
}

async function repointEveFunctionSymlinksInDirectory(
  directoryPath: string,
  sharedFunctionPath: string,
  functionsDir: string = directoryPath,
): Promise<void> {
  let entries: Dirent<string>[];

  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directoryPath, entry.name);
      const relativeFunctionPath = normalizeVercelOutputPath(relative(functionsDir, entryPath));

      if (entry.isSymbolicLink()) {
        if (entry.name.endsWith(".func") && isEveVercelFunctionPath(relativeFunctionPath)) {
          await repointFunctionSymlink(entryPath, sharedFunctionPath);
        }
        return;
      }

      if (entry.isDirectory() && !entry.name.endsWith(".func")) {
        await repointEveFunctionSymlinksInDirectory(entryPath, sharedFunctionPath, functionsDir);
      }
    }),
  );
}

async function repointFunctionSymlink(
  functionPath: string,
  sharedFunctionPath: string,
): Promise<void> {
  await rm(functionPath, {
    force: true,
    recursive: true,
  });
  await symlink(
    normalizeVercelOutputPath(relative(dirname(functionPath), sharedFunctionPath)),
    functionPath,
    "dir",
  );
}

async function pruneNonEveFunctionEntries(
  functionsDir: string,
  directoryPath: string,
): Promise<void> {
  let entries: Dirent<string>[];

  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directoryPath, entry.name);
      const relativeFunctionPath = normalizeVercelOutputPath(relative(functionsDir, entryPath));

      if (entry.name.endsWith(".func")) {
        if (!isEveVercelFunctionPath(relativeFunctionPath)) {
          await rm(entryPath, {
            force: true,
            recursive: true,
          });
        }
        return;
      }

      if (entry.isDirectory()) {
        await pruneNonEveFunctionEntries(functionsDir, entryPath);
      }
    }),
  );
}

async function pruneNonEveVercelRoutes(
  outputDir: string,
  servicePrefix: string | undefined,
): Promise<void> {
  const configPath = join(outputDir, "config.json");
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.routes)) {
    return;
  }

  parsed.routes = normalizeEveVercelRoutes(parsed.routes, servicePrefix);
  await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

function normalizeVercelOutputPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Bundles one package-owned workflow handler into a standalone Vercel function
 * directory without inheriting Nitro's hosted server chunks.
 */
export async function emitBundledWorkflowFunctionDirectory(input: {
  bundlePath: string;
  pluginPaths?: readonly string[];
  targetPath: string;
}): Promise<void> {
  await prepareVercelFunctionDirectory(input.targetPath);

  const pluginModulePaths = await emitBundledWorkflowPluginModules({
    pluginPaths: input.pluginPaths ?? [],
    targetPath: input.targetPath,
  });
  const entrypointId = join(dirname(input.bundlePath), "__eve_workflow_function_entry.js");
  const outputFile = await buildSingleRolldownChunk(
    `Vercel workflow function for "${input.bundlePath}"`,
    {
      cwd: dirname(input.bundlePath),
      input: entrypointId,
      platform: "node",
      plugins: [
        createVirtualModulePlugin({
          id: entrypointId,
          moduleType: "js",
          source: createWorkflowFunctionEntrypointSource({
            bundlePath: input.bundlePath,
            pluginModulePaths,
          }),
        }),
      ],
      output: {
        comments: false,
        format: "cjs",
        sourcemap: false,
      },
    },
  );

  await Promise.all([
    writeFile(join(input.targetPath, "index.js"), outputFile.code),
    writeFile(
      join(input.targetPath, "package.json"),
      `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
    ),
    writeFile(
      join(input.targetPath, ".vc-config.json"),
      `${JSON.stringify(
        {
          environment: createWorkflowFunctionEnvironment(),
          handler: "index.js",
          launcherType: "Nodejs",
          supportsResponseStreaming: true,
        },
        null,
        2,
      )}\n`,
    ),
  ]);
}

async function emitBundledWorkflowPluginModules(input: {
  pluginPaths: readonly string[];
  targetPath: string;
}): Promise<string[]> {
  return await Promise.all(
    input.pluginPaths.map(async (pluginPath, index) => {
      const outputFile = await buildSingleRolldownChunk(`workflow plugin for "${pluginPath}"`, {
        input: pluginPath,
        platform: "node",
        output: {
          comments: false,
          format: "esm",
          sourcemap: false,
        },
      });

      const emittedPluginFilename = `__eve_workflow_plugin_${index}.mjs`;
      await writeFile(join(input.targetPath, emittedPluginFilename), outputFile.code);
      return `./${emittedPluginFilename}`;
    }),
  );
}

function createVirtualModulePlugin(input: {
  id: string;
  moduleType: "js";
  source: string;
}): Record<string, unknown> {
  return {
    name: "eve-virtual-module",
    resolveId(source: string) {
      return source === input.id ? input.id : undefined;
    },
    load(id: string) {
      return id === input.id
        ? {
            code: input.source,
            moduleType: input.moduleType,
          }
        : undefined;
    },
  };
}

function toRelativeImportPath(input: { fromDirectoryPath: string; toFilePath: string }): string {
  const relativePath = relative(input.fromDirectoryPath, input.toFilePath).replaceAll("\\", "/");

  if (relativePath.startsWith(".")) {
    return relativePath;
  }

  return `./${relativePath}`;
}

function normalizeImportSpecifierPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function createWorkflowFunctionEntrypointSource(input: {
  bundlePath: string;
  pluginModulePaths: readonly string[];
}): string {
  const normalizedPluginModulePaths = input.pluginModulePaths.map((pluginPath) =>
    normalizeImportSpecifierPath(pluginPath),
  );
  const hasWorkflowPlugins = normalizedPluginModulePaths.length > 0;

  return [
    `const { POST } = require(${JSON.stringify(`./${basename(input.bundlePath)}`)});`,
    ...(hasWorkflowPlugins
      ? [
          `const workflowPluginModulePaths = ${JSON.stringify(normalizedPluginModulePaths)};`,
          "",
          "let workflowPluginPromise;",
          "",
          "async function loadWorkflowPlugins() {",
          "  if (workflowPluginPromise == null) {",
          "    workflowPluginPromise = (async () => {",
          "      for (const pluginPath of workflowPluginModulePaths) {",
          "        await import(pluginPath);",
          "      }",
          "    })();",
          "  }",
          "  return await workflowPluginPromise;",
          "}",
        ]
      : []),
    "",
    'const DEFAULT_WORKFLOW_REQUEST_ORIGIN = "https://workflow.invalid";',
    "",
    "function getHeader(headers, name) {",
    "  if (headers === null || headers === undefined) {",
    "    return undefined;",
    "  }",
    '  if (typeof headers.get === "function") {',
    "    const value = headers.get(name);",
    '    return typeof value === "string" && value.length > 0 ? value : undefined;',
    "  }",
    '  if (typeof headers !== "object") {',
    "    return undefined;",
    "  }",
    "  const record = headers;",
    "  const lowerName = name.toLowerCase();",
    "  for (const [key, value] of Object.entries(record)) {",
    "    if (key.toLowerCase() !== lowerName || value === undefined) {",
    "      continue;",
    "    }",
    "    if (Array.isArray(value)) {",
    '      return value.find((item) => typeof item === "string" && item.length > 0);',
    "    }",
    '    return typeof value === "string" && value.length > 0 ? value : undefined;',
    "  }",
    "  return undefined;",
    "}",
    "",
    "function createHeaders(headers) {",
    "  const normalized = new Headers();",
    "  if (headers === null || headers === undefined) {",
    "    return normalized;",
    "  }",
    "  if (headers instanceof Headers) {",
    "    return headers;",
    "  }",
    '  if (typeof headers.forEach === "function" && typeof headers.entries === "function") {',
    "    for (const [key, value] of headers.entries()) {",
    "      normalized.append(key, value);",
    "    }",
    "    return normalized;",
    "  }",
    "  for (const [key, value] of Object.entries(headers)) {",
    "    if (value === undefined) {",
    "      continue;",
    "    }",
    "    if (Array.isArray(value)) {",
    "      for (const item of value) {",
    "        normalized.append(key, String(item));",
    "      }",
    "      continue;",
    "    }",
    "    normalized.set(key, String(value));",
    "  }",
    "  return normalized;",
    "}",
    "",
    "function toAbsoluteWorkflowUrl(request) {",
    '  const url = typeof request?.url === "string" ? request.url : "/";',
    "  if (/^https?:\\/\\//.test(url)) {",
    "    return url;",
    "  }",
    '  const host = getHeader(request?.headers, "x-forwarded-host") ?? getHeader(request?.headers, "host");',
    '  const protocolHeader = getHeader(request?.headers, "x-forwarded-proto");',
    '  const protocol = protocolHeader === "http" || protocolHeader === "https" ? protocolHeader : "https";',
    '  const origin = typeof host === "string" && host.length > 0 ? protocol + "://" + host : DEFAULT_WORKFLOW_REQUEST_ORIGIN;',
    "  return new URL(url, origin).toString();",
    "}",
    "",
    "function normalizeWorkflowRequest(request) {",
    "  if (request instanceof Request) {",
    "    if (/^https?:\\/\\//.test(request.url)) {",
    "      return request;",
    "    }",
    "    return new Request(toAbsoluteWorkflowUrl(request), request);",
    "  }",
    '  const method = typeof request?.method === "string" ? request.method : "GET";',
    "  const headers = createHeaders(request?.headers);",
    "  const init = {",
    "    headers,",
    "    method,",
    "  };",
    '  if (method !== "GET" && method !== "HEAD") {',
    '    const body = request?.body ?? (request !== null && typeof request === "object" && typeof request.pipe === "function" ? request : undefined);',
    "    if (body !== undefined) {",
    "      init.body = body;",
    '      init.duplex = "half";',
    "    }",
    "  }",
    "  return new Request(toAbsoluteWorkflowUrl(request), init);",
    "}",
    "",
    "module.exports = async function handleWorkflowFunctionRequest(requestContext) {",
    "  const request =",
    '    requestContext !== null && typeof requestContext === "object" && "req" in requestContext',
    "      ? requestContext.req",
    "      : requestContext;",
    ...(hasWorkflowPlugins ? ["  await loadWorkflowPlugins();"] : []),
    "  return await POST(normalizeWorkflowRequest(request));",
    "};",
    "",
  ].join("\n");
}

function createRoutedNitroEntrypoint(input: {
  delegateImportPath: string;
  workflowRoutePath: string;
}): string {
  return [
    `import nitroHandler from ${JSON.stringify(input.delegateImportPath)};`,
    "",
    "function invokeNitroHandler(request, context) {",
    '  if (typeof nitroHandler === "function") {',
    "    return nitroHandler(request, context);",
    "  }",
    "",
    '  if (nitroHandler !== null && typeof nitroHandler === "object" && "fetch" in nitroHandler) {',
    "    const fetch = nitroHandler.fetch;",
    '    if (typeof fetch === "function") {',
    "      return fetch.call(nitroHandler, request, context);",
    "    }",
    "  }",
    "",
    '  throw new TypeError("Expected Nitro handler to export a function or an object with fetch(request, context).");',
    "}",
    "",
    `const workflowRoutePath = ${JSON.stringify(input.workflowRoutePath)};`,
    "",
    "function rewriteRequestToWorkflowRoute(request) {",
    "  const sourceUrl = new URL(request.url);",
    "  const routedUrl = new URL(workflowRoutePath, sourceUrl);",
    "  routedUrl.search = sourceUrl.search;",
    "  return new Request(routedUrl, request);",
    "}",
    "",
    "export default {",
    "  fetch(request, context) {",
    "    return invokeNitroHandler(rewriteRequestToWorkflowRoute(request), context);",
    "  },",
    "};",
    "",
  ].join("\n");
}

async function readVercelHandlerPath(functionDirectoryPath: string): Promise<string> {
  try {
    const parsed = JSON.parse(
      await readFile(join(functionDirectoryPath, ".vc-config.json"), "utf8"),
    ) as {
      handler?: unknown;
    };
    if (typeof parsed.handler === "string" && parsed.handler.length > 0) {
      return parsed.handler;
    }
  } catch {
    // fall through
  }

  return "index.mjs";
}

/**
 * Rewrites one copied Nitro function directory so its handler always dispatches
 * to a concrete workflow route path.
 *
 * Queue-triggered workflow functions do not guarantee a request URL that
 * matches Nitro's original route table. This helper keeps Nitro's traced
 * output intact but swaps the entrypoint with a small URL-rewriting adapter.
 */
export async function retargetNitroFunctionDirectoryToWorkflowRoute(input: {
  functionDirectoryPath: string;
  workflowRoutePath: string;
}): Promise<void> {
  const handlerPath = await readVercelHandlerPath(input.functionDirectoryPath);
  const handlerFilePath = join(input.functionDirectoryPath, handlerPath);
  const handlerDirectoryPath = dirname(handlerFilePath);
  const handlerExtension = extname(handlerPath);
  const delegatedHandlerFilePath = join(
    handlerDirectoryPath,
    `__eve_nitro_handler__${handlerExtension.length > 0 ? handlerExtension : ".mjs"}`,
  );
  const delegatedHandlerImportPath = toRelativeImportPath({
    fromDirectoryPath: handlerDirectoryPath,
    toFilePath: delegatedHandlerFilePath,
  });

  await rename(handlerFilePath, delegatedHandlerFilePath);
  await writeFile(
    handlerFilePath,
    createRoutedNitroEntrypoint({
      delegateImportPath: delegatedHandlerImportPath,
      workflowRoutePath: input.workflowRoutePath,
    }),
  );
}
