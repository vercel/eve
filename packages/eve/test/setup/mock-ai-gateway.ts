import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AI_GATEWAY_MODELS_CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models/catalog";
const DEFAULT_CONTEXT_WINDOW_TOKENS = 400_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 128_000;
const SCANNED_FILE_EXTENSIONS = new Set([".cts", ".js", ".json", ".mjs", ".mts", ".ts"]);
const IGNORED_DIRECTORY_NAMES = new Set([
  ".eve",
  ".git",
  ".output",
  ".swc",
  ".turbo",
  ".workflow-data",
  "coverage",
  "dist",
  "node_modules",
]);
const explicitModelIdPattern = /(?:model|runtimeModelId)\s*:\s*["']([^"'\\]+\/[^"'\\]+)["']/g;
const assignedModelIdPattern = /runtimeModelId\s*=\s*["']([^"'\\]+\/[^"'\\]+)["']/g;
const providerFirstPattern =
  /provider\s*:\s*["']([^"'\\]+)["'][\s\S]{0,400}?modelId\s*:\s*["']([^"'\\]+)["']/g;
const modelIdFirstPattern =
  /modelId\s*:\s*["']([^"'\\]+)["'][\s\S]{0,400}?provider\s*:\s*["']([^"'\\]+)["']/g;

const repoModelIds = collectGatewayModelIds([
  resolvePathFromSetup(".."),
  resolvePathFromSetup("../../src/internal/testing/scenario-apps"),
]);
const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = (async (input, init) => {
  const url = getRequestUrl(input);

  if (url === AI_GATEWAY_MODELS_CATALOG_URL) {
    return createGatewayModelCatalogResponse(repoModelIds);
  }

  return await originalFetch(input, init);
}) as typeof globalThis.fetch;

function createGatewayModelCatalogResponse(modelIds: ReadonlySet<string>): Response {
  return new Response(
    JSON.stringify({
      models: [...modelIds].sort().map((id) => ({
        slug: id,
        providers: [
          {
            provider: id.split("/")[0],
            providerModelId: id.split("/").slice(1).join("/"),
            contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
            maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          },
        ],
      })),
      providerAliases: {},
    }),
    {
      headers: {
        "content-type": "application/json",
      },
      status: 200,
    },
  );
}

function collectGatewayModelIds(rootPaths: readonly string[]): ReadonlySet<string> {
  const ids = new Set<string>([
    "anthropic/claude-opus-4.7",
    "anthropic/claude-sonnet-4.6",
    "openai/gpt-5.4",
    "openai/gpt-5.4-mini",
  ]);

  for (const rootPath of rootPaths) {
    collectGatewayModelIdsFromDirectory(rootPath, ids);
  }

  return ids;
}

function collectGatewayModelIdsFromDirectory(directoryPath: string, ids: Set<string>): void {
  for (const entry of readdirSync(directoryPath, {
    recursive: false,
    withFileTypes: true,
  })) {
    if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }

    const entryPath = join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      collectGatewayModelIdsFromDirectory(entryPath, ids);
      continue;
    }

    if (!entry.isFile() || !SCANNED_FILE_EXTENSIONS.has(extname(entry.name))) {
      continue;
    }

    collectGatewayModelIdsFromSource(readFileSync(entryPath, "utf8"), ids);
  }
}

function collectGatewayModelIdsFromSource(source: string, ids: Set<string>): void {
  for (const match of source.matchAll(explicitModelIdPattern)) {
    const modelId = match[1];

    if (modelId !== undefined) {
      ids.add(modelId);
    }
  }

  for (const match of source.matchAll(assignedModelIdPattern)) {
    const modelId = match[1];

    if (modelId !== undefined) {
      ids.add(modelId);
    }
  }

  for (const match of source.matchAll(providerFirstPattern)) {
    const provider = match[1];
    const modelId = match[2];

    if (provider !== undefined && modelId !== undefined) {
      ids.add(`${provider}/${modelId}`);
    }
  }

  for (const match of source.matchAll(modelIdFirstPattern)) {
    const modelId = match[1];
    const provider = match[2];

    if (provider !== undefined && modelId !== undefined) {
      ids.add(`${provider}/${modelId}`);
    }
  }
}

function getRequestUrl(input: Parameters<typeof fetch>[0]): string {
  if (input instanceof Request) {
    return input.url;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return String(input);
}

function resolvePathFromSetup(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}
