import { readFile } from "node:fs/promises";

import { parseJsonObject, type JsonObject, type JsonValue } from "#shared/json.js";

export interface VercelServiceMount {
  readonly path?: string;
  readonly subdomain?: string;
}

export interface VercelServiceRouteDestination {
  readonly service?: string;
  readonly type?: string;
}

export interface VercelRouteTransform {
  readonly args?: string;
  readonly op?: string;
  readonly type?: string;
  readonly [key: string]: JsonValue | undefined;
}

export interface VercelRouteConfig {
  readonly destination?: string | VercelServiceRouteDestination;
  readonly handle?: string;
  readonly src?: string;
  readonly transforms?: readonly VercelRouteTransform[];
  readonly [key: string]: unknown;
}

export interface VercelServiceConfig {
  readonly buildCommand?: string;
  readonly devCommand?: string;
  readonly entrypoint?: string;
  readonly framework?: string;
  readonly mount?: string | VercelServiceMount;
  readonly routes?: readonly VercelRouteConfig[];
  readonly routePrefix?: string;
  readonly root?: string;
  readonly type?: string;
}

export interface GeneratedVercelServiceConfig extends VercelServiceConfig {
  readonly buildCommand: string;
  readonly devCommand?: string;
  readonly framework: "eve";
  readonly root: string;
  readonly routes: readonly VercelRouteConfig[];
}

export type VercelServicesCollection =
  | Record<string, VercelServiceConfig>
  | readonly (VercelServiceConfig & { readonly name: string })[];

export interface VercelServicesConfig {
  readonly experimentalServices?: JsonValue;
  readonly experimentalServicesV2?: JsonValue;
  readonly routes?: readonly VercelRouteConfig[];
  readonly services?: VercelServicesCollection;
  readonly [key: string]: unknown;
}

function optionalString(value: JsonValue | undefined, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
  return value;
}

function objectValue(value: JsonValue, path: string): JsonObject {
  try {
    return parseJsonObject(value);
  } catch {
    throw new Error(`${path} must contain a JSON object.`);
  }
}

function parseDestination(
  value: JsonValue | undefined,
  path: string,
): string | VercelServiceRouteDestination | undefined {
  if (value === undefined || typeof value === "string") return value;
  let destination: JsonObject;
  try {
    destination = parseJsonObject(value);
  } catch {
    throw new Error(`${path} must be a string or JSON object.`);
  }
  return {
    ...destination,
    service: optionalString(destination.service, `${path}.service`),
    type: optionalString(destination.type, `${path}.type`),
  };
}

function parseRoute(value: JsonValue, path: string): VercelRouteConfig {
  const route = objectValue(value, path);
  return {
    ...route,
    destination: parseDestination(route.destination, `${path}.destination`),
    handle: optionalString(route.handle, `${path}.handle`),
    src: optionalString(route.src, `${path}.src`),
  };
}

function parseArray<T>(
  value: JsonValue | undefined,
  path: string,
  parseEntry: (entry: JsonValue, path: string) => T,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value.map((entry, index) => parseEntry(entry, `${path}[${index}]`));
}

function parseMount(
  value: JsonValue | undefined,
  path: string,
): string | VercelServiceMount | undefined {
  if (value === undefined || typeof value === "string") return value;
  let mount: JsonObject;
  try {
    mount = parseJsonObject(value);
  } catch {
    throw new Error(`${path} must be a string or JSON object.`);
  }
  return {
    ...mount,
    path: optionalString(mount.path, `${path}.path`),
    subdomain: optionalString(mount.subdomain, `${path}.subdomain`),
  };
}

function parseServiceConfig(value: JsonValue, path: string): VercelServiceConfig {
  const service = objectValue(value, path);
  return {
    ...service,
    buildCommand: optionalString(service.buildCommand, `${path}.buildCommand`),
    devCommand: optionalString(service.devCommand, `${path}.devCommand`),
    entrypoint: optionalString(service.entrypoint, `${path}.entrypoint`),
    framework: optionalString(service.framework, `${path}.framework`),
    mount: parseMount(service.mount, `${path}.mount`),
    routes: parseArray(service.routes, `${path}.routes`, parseRoute),
    routePrefix: optionalString(service.routePrefix, `${path}.routePrefix`),
    root: optionalString(service.root, `${path}.root`),
    type: optionalString(service.type, `${path}.type`),
  };
}

function parseServices(
  value: JsonValue | undefined,
  fileName: string,
): VercelServicesCollection | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      const path = `${fileName} services[${index}]`;
      const service = objectValue(entry, path);
      const name = optionalString(service.name, `${path}.name`);
      if (name === undefined || name.trim().length === 0) {
        throw new Error(`${path} must have a non-empty name.`);
      }
      const { name: _name, ...config } = service;
      return { ...parseServiceConfig(config, path), name };
    });
  }

  let services: JsonObject;
  try {
    services = parseJsonObject(value);
  } catch {
    throw new Error(`${fileName} services must be a JSON object or named service array.`);
  }
  return Object.fromEntries(
    Object.entries(services).map(([name, service]) => [
      name,
      parseServiceConfig(service, `${fileName} service ${JSON.stringify(name)}`),
    ]),
  );
}

/** Parse the Vercel configuration fields used by eve while preserving other JSON fields. */
export function parseVercelServicesConfig(value: unknown, fileName: string): VercelServicesConfig {
  let config: JsonObject;
  try {
    config = parseJsonObject(value);
  } catch {
    throw new Error(`${fileName} must contain a JSON object.`);
  }

  return {
    ...config,
    routes: parseArray(config.routes, `${fileName} routes`, parseRoute),
    services: parseServices(config.services, fileName),
  };
}

function isNamedServiceArray(
  services: VercelServicesCollection,
): services is readonly (VercelServiceConfig & { readonly name: string })[] {
  return Array.isArray(services);
}

export function createServiceConfigRecord(
  services: VercelServicesCollection | undefined,
): Record<string, VercelServiceConfig> {
  if (services === undefined) return {};
  if (!isNamedServiceArray(services)) return services;
  return Object.fromEntries(services.map(({ name, ...service }) => [name, service]));
}

export function hasServices(
  services: VercelServicesCollection | undefined,
): services is VercelServicesCollection {
  return Object.keys(createServiceConfigRecord(services)).length > 0;
}

export async function readVercelJsonFile(path: string): Promise<VercelServicesConfig> {
  try {
    return parseVercelServicesConfig(JSON.parse(await readFile(path, "utf8")) as unknown, path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}
