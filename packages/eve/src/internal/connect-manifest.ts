import type { JsonObject } from "#shared/json.js";
import type {
  ExternalResource,
  ExternalResourcesSnapshot,
} from "#internal/external-resources-snapshot.js";

const CONNECT_MANIFEST_KIND = "vercel-connect-manifest";
const CONNECT_MANIFEST_VERSION = 1;
const RFC_7591_MANIFEST = { $type: "https://datatracker.ietf.org/doc/html/rfc7591" };

export type ConnectSubjectType = "app" | "user";

export type ConnectInterface =
  | { readonly protocol: "mcp" | "openapi"; readonly url: string }
  | {
      readonly npm: string;
      readonly protocol: "custom";
      readonly url: string;
    };

export interface ConnectRequirement {
  readonly connect: {
    readonly manifest: JsonObject;
    readonly service: string;
    readonly subjectTypes: readonly ConnectSubjectType[];
    type?: string;
  };
  readonly interfaces: readonly ConnectInterface[];
  readonly target: string;
  readonly triggers: readonly { readonly path: string }[];
  readonly uses: readonly {
    readonly kind: "channel" | "connection";
    readonly logicalPath: string;
    readonly name: string;
  }[];
}

export interface ConnectManifest {
  readonly generator: { readonly name: string; readonly version: string };
  readonly kind: typeof CONNECT_MANIFEST_KIND;
  readonly requirements: readonly ConnectRequirement[];
  readonly schemaVersion: typeof CONNECT_MANIFEST_VERSION;
}

export function createConnectManifest(
  snapshot: ExternalResourcesSnapshot,
): ConnectManifest | undefined {
  if (snapshot.resources.length === 0) return undefined;
  return {
    generator: snapshot.generator,
    kind: CONNECT_MANIFEST_KIND,
    schemaVersion: CONNECT_MANIFEST_VERSION,
    requirements: collectConnectRequirements(snapshot.resources),
  };
}

function collectConnectRequirements(
  resources: readonly ExternalResource[],
): readonly ConnectRequirement[] {
  const requirements = new Map<string, ConnectRequirement>();
  for (const resource of resources) {
    const next = toConnectRequirement(resource);
    const current = requirements.get(next.target);
    if (current === undefined) {
      requirements.set(next.target, next);
      continue;
    }
    const connect = mergeRequirementConfiguration(current, next);
    requirements.set(next.target, {
      ...current,
      connect,
      interfaces: appendDistinct(current.interfaces, next.interfaces),
      triggers: appendDistinct(current.triggers, next.triggers),
      uses: appendDistinct(current.uses, next.uses),
    });
  }
  return [...requirements.values()];
}

function mergeRequirementConfiguration(
  current: ConnectRequirement,
  next: ConnectRequirement,
): ConnectRequirement["connect"] {
  const conflict = (field: string): never => {
    throw new Error(
      `Conflicting declarations for credential target "${current.target}" in ${current.uses.map((use) => use.logicalPath).join(", ")} and ${next.uses.map((use) => use.logicalPath).join(", ")}: ${field} must agree.`,
    );
  };
  if (current.connect.service !== next.connect.service) conflict("service");
  if (current.connect.type && next.connect.type && current.connect.type !== next.connect.type) {
    conflict("method");
  }
  const currentManifest = current.connect.manifest;
  const nextManifest = next.connect.manifest;
  const credentialOnly = (manifest: JsonObject): boolean =>
    Object.keys(manifest).length === 1 && manifest.$type === RFC_7591_MANIFEST.$type;
  if (
    !credentialOnly(currentManifest) &&
    !credentialOnly(nextManifest) &&
    canonicalJson(currentManifest) !== canonicalJson(nextManifest)
  ) {
    conflict("provider manifest");
  }
  const type = current.connect.type ?? next.connect.type;
  const connect: ConnectRequirement["connect"] = {
    service: current.connect.service,
    subjectTypes: [
      ...new Set([...current.connect.subjectTypes, ...next.connect.subjectTypes]),
    ].sort(),
    manifest: credentialOnly(currentManifest) ? nextManifest : currentManifest,
  };
  if (type !== undefined) connect.type = type;
  return connect;
}

function appendDistinct<T>(current: readonly T[], additional: readonly T[]): readonly T[] {
  const seen = new Set(current.map((value) => canonicalJson(value)));
  return [
    ...current,
    ...additional.filter((value) => {
      const key = canonicalJson(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function toConnectRequirement(resource: ExternalResource): ConnectRequirement {
  const connect: ConnectRequirement["connect"] = {
    manifest:
      resource.kind === "channel" && resource.manifest !== undefined
        ? resource.manifest
        : RFC_7591_MANIFEST,
    service: resource.credentials.service,
    subjectTypes: resource.credentials.subjectTypes,
  };
  if (resource.credentials.method !== undefined) connect.type = resource.credentials.method;
  return {
    connect,
    interfaces:
      resource.kind === "connection"
        ? [{ protocol: resource.protocol.type, url: resource.protocol.url }]
        : [],
    target: resource.credentials.reference,
    triggers: resource.kind === "channel" ? [resource.route] : [],
    uses: [
      {
        kind: resource.kind,
        logicalPath: resource.logicalPath,
        name: resource.name,
      },
    ],
  };
}
