import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RegistryConfig, RegistrySource } from "#compiled/shadcn-registry/index.js";

interface RegistryPackage {
  path: string;
  document: Record<string, unknown>;
  config: RegistryConfig;
}

export interface AddRegistryMappingsResult {
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

// TODO: Replace this package.json handling with shadcn's registry config APIs
// after shadcn-ui/ui#11304 and shadcn-ui/ui#11295 are released.
async function readRegistryPackage(appRoot: string): Promise<RegistryPackage> {
  const path = join(appRoot, "package.json");
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

/** Reads registry namespace mappings from package.json. */
export async function readRegistryConfig(appRoot: string): Promise<RegistryConfig> {
  return (await readRegistryPackage(appRoot)).config;
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
    if (mapping.namespace === "@shadcn") {
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
