import type { JsonObject } from "#shared/json.js";

export const EXTERNAL_RESOURCES_SNAPSHOT_KIND = "eve-external-resources";
export const EXTERNAL_RESOURCES_SNAPSHOT_VERSION = 1;

export interface ExternalCredentialRequirement {
  readonly method?: string;
  readonly reference: string;
  readonly service: string;
  readonly subjectTypes: readonly ("app" | "user")[];
}

interface ExternalResourceBase {
  readonly credentials: ExternalCredentialRequirement;
  readonly logicalPath: string;
  readonly name: string;
}

export interface ExternalConnectionResource extends ExternalResourceBase {
  readonly kind: "connection";
  readonly protocol:
    | { readonly type: "mcp"; readonly url: string }
    | { readonly type: "openapi"; readonly url: string };
}

export interface ExternalChannelResource extends ExternalResourceBase {
  readonly kind: "channel";
  readonly manifest: JsonObject;
  readonly route: { readonly path: string };
}

export type ExternalResource = ExternalConnectionResource | ExternalChannelResource;

export interface ExternalResourcesSnapshot {
  readonly generator: { readonly name: "eve"; readonly version: string };
  readonly kind: typeof EXTERNAL_RESOURCES_SNAPSHOT_KIND;
  readonly resources: readonly ExternalResource[];
  readonly schemaVersion: typeof EXTERNAL_RESOURCES_SNAPSHOT_VERSION;
}

export function createExternalResourcesSnapshot(input: {
  readonly generatorVersion: string;
  readonly resources: readonly ExternalResource[];
}): ExternalResourcesSnapshot {
  return {
    generator: { name: "eve", version: input.generatorVersion },
    kind: EXTERNAL_RESOURCES_SNAPSHOT_KIND,
    resources: input.resources,
    schemaVersion: EXTERNAL_RESOURCES_SNAPSHOT_VERSION,
  };
}
