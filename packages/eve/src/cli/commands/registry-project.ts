import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  applyEdits as applyJsoncEdits,
  modify as modifyJsonc,
  type ParseError,
  parse as parseJsonc,
} from "#compiled/jsonc-parser/index.js";
import type { RegistryConfig, RegistrySource } from "#compiled/shadcn-registry/index.js";
import { resolveEveProjectContext } from "#internal/project-context.js";
import type { Asker } from "#setup/ask.js";
import {
  detectWebChatFramework,
  WEB_CHAT_FRAMEWORK_LABELS,
  WEB_FRAMEWORK_QUESTION,
  type WebChatFramework,
} from "#setup/integrations/web/framework.js";
import {
  WEB_APP_TANSTACK_TEMPLATE_FILES,
  WEB_APP_TEMPLATE_FILES,
} from "#setup/scaffold/create/web-template.js";

interface RegistryPackage {
  path: string;
  document: Record<string, unknown>;
  config: RegistryConfig;
}

interface AddRegistryMappingsResult {
  added: string[];
  skippedBuiltIn: string[];
  skippedExisting: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRegistrySource(value: unknown): value is RegistrySource {
  if (typeof value === "string") return true;
  if (typeof value !== "object" || value === null || !("url" in value)) return false;
  return typeof (value as { url?: unknown }).url === "string";
}

function parseRegistries(path: string, value: unknown): Record<string, RegistrySource> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} has an invalid registries field.`);
  }

  const registries: Record<string, RegistrySource> = {};
  for (const [namespace, source] of Object.entries(value)) {
    if (!namespace.startsWith("@") || !isRegistrySource(source)) {
      throw new Error(`${path} has an invalid registry entry for ${namespace}.`);
    }
    registries[namespace] = source;
  }
  return registries;
}

async function readRegistryPackage(appRoot: string): Promise<RegistryPackage> {
  const context = await resolveEveProjectContext(appRoot);
  const path = join(context.environmentRoot, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path}: ${errorMessage(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }

  const document = parsed as Record<string, unknown>;
  return {
    path,
    document,
    config: { registries: parseRegistries(path, document.registries) },
  };
}

function parseRegistryMapping(argument: string): { namespace: string; url: string } {
  const separator = argument.indexOf("=");
  const namespace = separator === -1 ? argument : argument.slice(0, separator);
  const url = separator === -1 ? "" : argument.slice(separator + 1);
  if (!namespace.startsWith("@")) {
    throw new Error(`Registry namespaces must start with @: ${namespace}`);
  }
  if (!url.includes("{name}")) {
    throw new Error(
      `Pass a registry URL containing {name}, for example ${namespace}=https://example.com/r/{name}.json.`,
    );
  }
  return { namespace, url };
}

/** Dev and build commands that run the Web Chat app in `apps/web`, by host framework. */
const WEB_CHAT_SCRIPTS: Readonly<Record<WebChatFramework, Readonly<Record<string, string>>>> = {
  next: { "dev:web": "next dev apps/web", "build:web": "next build apps/web" },
  tanstack: { "dev:web": "vite dev apps/web", "build:web": "vite build apps/web" },
};

function isWebChatScriptDefault(name: string, command: string): boolean {
  return Object.values(WEB_CHAT_SCRIPTS).some((scripts) => scripts[name] === command);
}

/**
 * Picks the framework `eve add channel/web` installs, before it writes any file.
 * An app already in `apps/web` decides; an explicit answer that conflicts fails.
 */
export async function resolveWebChatFramework(
  appRoot: string,
  asker: Asker,
  answers: Readonly<Record<string, unknown>> = {},
): Promise<WebChatFramework> {
  const project = await resolveEveProjectContext(appRoot);
  if (project.kind === "workspace") {
    throw new Error("Web Chat setup requires a selected workspace agent.");
  }
  const existing = await detectWebChatFramework(join(project.environmentRoot, "apps", "web"));
  if (existing !== undefined && !(WEB_FRAMEWORK_QUESTION.key in answers)) return existing;
  const framework = await asker.ask(WEB_FRAMEWORK_QUESTION);
  if (existing !== undefined && framework !== existing) {
    throw new Error(
      `apps/web already contains a ${WEB_CHAT_FRAMEWORK_LABELS[existing]} app. Remove apps/web to switch Web Chat to ${WEB_CHAT_FRAMEWORK_LABELS[framework]}, or answer ${WEB_FRAMEWORK_QUESTION.key}="${existing}".`,
    );
  }
  return framework;
}

/** Resolves and prepares the root package that owns Web Chat. */
export async function prepareWebChatProjectRoot(
  appRoot: string,
  framework: WebChatFramework = "next",
): Promise<string> {
  const project = await resolveEveProjectContext(appRoot);
  if (project.kind === "workspace") {
    throw new Error("Web Chat setup requires a selected workspace agent.");
  }
  const root = project.environmentRoot;
  const packageJsonPath = join(root, "package.json");
  const source = await readFile(packageJsonPath, "utf8");
  const document = JSON.parse(source) as {
    scripts?: Record<string, string>;
    [key: string]: unknown;
  };
  const scripts = { ...document.scripts };
  for (const [name, command] of Object.entries(WEB_CHAT_SCRIPTS[framework])) {
    const current = scripts[name];
    // Another framework's installer default would run the wrong dev server.
    if (current === undefined || isWebChatScriptDefault(name, current)) {
      scripts[name] = command;
    }
  }
  await writeFile(
    packageJsonPath,
    `${JSON.stringify({ ...document, scripts }, null, 2)}\n`,
    "utf8",
  );
  return root;
}

/** Reads registry namespace mappings from package.json. */
export async function readRegistryConfig(appRoot: string): Promise<RegistryConfig> {
  return (await readRegistryPackage(appRoot)).config;
}

const JSONC_FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" } as const;

function setJsoncValue(source: string, path: (string | number)[], value: unknown): string {
  return applyJsoncEdits(
    source,
    modifyJsonc(source, path, value, { formattingOptions: JSONC_FORMATTING }),
  );
}

interface WebRegistryTsconfigTemplate {
  compilerOptions: Record<string, unknown>;
  include: string[];
  exclude: string[];
}

const WEB_REGISTRY_TSCONFIG_SOURCES: Readonly<Record<WebChatFramework, string>> = {
  next: WEB_APP_TEMPLATE_FILES["tsconfig.json"],
  tanstack: WEB_APP_TANSTACK_TEMPLATE_FILES["tsconfig.json"],
};

export function addWebRegistryTsconfig(
  source: string,
  path: string,
  framework: WebChatFramework = "next",
): string {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Could not add Web Chat because ${path} is not a valid JSON object.`);
  }

  const document = parsed as {
    compilerOptions?: {
      paths?: Record<string, unknown>;
      plugins?: unknown[];
      [key: string]: unknown;
    };
    include?: string[];
    exclude?: string[];
  };
  const template = JSON.parse(
    WEB_REGISTRY_TSCONFIG_SOURCES[framework],
  ) as WebRegistryTsconfigTemplate;
  const configuredAlias = document.compilerOptions?.paths?.["@/*"];
  if (
    configuredAlias !== undefined &&
    (!Array.isArray(configuredAlias) || !configuredAlias.includes("./*"))
  ) {
    throw new Error(
      `Could not add Web Chat because ${path} already defines @/* without mapping it to ./*.`,
    );
  }

  let updated = source;
  for (const [key, value] of Object.entries(template.compilerOptions)) {
    if (key === "paths" || key === "plugins") continue;
    const current = document.compilerOptions?.[key];
    if (current === undefined) {
      updated = setJsoncValue(updated, ["compilerOptions", key], value);
    } else if (key === "types" && Array.isArray(current) && Array.isArray(value)) {
      // Vite's `import.meta.env` typings must load alongside authored ambient types.
      const types = [...new Set([...current, ...value])];
      if (types.length > current.length) {
        updated = setJsoncValue(updated, ["compilerOptions", "types"], types);
      }
    }
  }
  if (configuredAlias === undefined) {
    updated = setJsoncValue(updated, ["compilerOptions", "paths", "@/*"], ["./*"]);
  }

  const plugins = document.compilerOptions?.plugins ?? [];
  const hasNextPlugin = plugins.some(
    (plugin) =>
      typeof plugin === "object" && plugin !== null && "name" in plugin && plugin.name === "next",
  );
  if (framework === "next" && !hasNextPlugin) {
    updated = setJsoncValue(
      updated,
      ["compilerOptions", "plugins"],
      [...plugins, { name: "next" }],
    );
  }
  updated = setJsoncValue(
    updated,
    ["include"],
    [...new Set([...(document.include ?? []), ...template.include])],
  );
  updated = setJsoncValue(
    updated,
    ["exclude"],
    [...new Set([...(document.exclude ?? []), ...template.exclude])],
  );
  return updated;
}

/** Prepares the TypeScript host configuration shadcn registry items expect. */
export async function prepareWebRegistryProject(
  appRoot: string,
  framework: WebChatFramework = "next",
): Promise<void> {
  const path = join(appRoot, "apps", "web", "tsconfig.json");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    // A fresh Web Chat gets its canonical tsconfig from the registry item
    // inside the rollback-protected install transaction.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `Could not add Web Chat because ${path} could not be read: ${errorMessage(error)}`,
    );
  }
  const updated = addWebRegistryTsconfig(source, path, framework);
  if (updated !== source) await writeFile(path, updated, "utf8");
}

/** Adds explicit registry namespace mappings to package.json. */
export async function addRegistryMappings(
  appRoot: string,
  arguments_: readonly string[],
): Promise<AddRegistryMappingsResult> {
  if (arguments_.length === 0) throw new Error("Pass at least one registry to add.");
  const project = await readRegistryPackage(appRoot);
  const mappings = arguments_.map(parseRegistryMapping);
  const configured = { ...project.config.registries };
  const result: AddRegistryMappingsResult = {
    added: [],
    skippedBuiltIn: [],
    skippedExisting: [],
  };

  for (const mapping of mappings) {
    if (mapping.namespace === "@shadcn" || mapping.namespace === "@skills") {
      result.skippedBuiltIn.push(mapping.namespace);
    } else if (configured[mapping.namespace] !== undefined) {
      result.skippedExisting.push(mapping.namespace);
    } else {
      configured[mapping.namespace] = mapping.url;
      result.added.push(mapping.namespace);
    }
  }

  if (result.added.length > 0) {
    await writeFile(
      project.path,
      `${JSON.stringify({ ...project.document, registries: configured }, null, 2)}\n`,
      "utf8",
    );
  }
  return result;
}
