import {
  expectAgentToolExposure,
  expectBoolean,
  expectObjectRecord,
  expectOnlyKnownKeys,
  expectString,
} from "#internal/authored-module.js";
import { EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import { assertDynamicSentinelKeys, isDynamicSentinel } from "#dynamic/definition.js";
import {
  type AgentSourceKind,
  type LocalSubagentSourceRef,
  sourcesOf,
} from "#discover/manifest.js";
import type { AgentToolExposure } from "#shared/agent-definition.js";

export type NormalizedSubagentConfig =
  | {
      readonly kind: "local";
      readonly definition: unknown;
    }
  | {
      readonly kind: "dynamic";
    }
  | {
      readonly description: string;
      readonly kind: "remote";
      readonly path: string;
      readonly tool?: AgentToolExposure;
      readonly url?: string;
    };

export function normalizeSubagentConfig(value: unknown, message: string): NormalizedSubagentConfig {
  // A dynamic subagent chooses the whole subagent: its description, or whether there is one. A
  // subagent the parent always sees, with a model chosen per session, is a defineAgent() whose
  // model field is dynamic.
  if (isDynamicSentinel(value)) {
    assertDynamicSentinelKeys(value, message);
    return { kind: "dynamic" };
  }

  if (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly kind?: unknown }).kind === "remote"
  ) {
    const record = expectObjectRecord(value, message);
    expectOnlyKnownKeys(
      record,
      ["auth", "description", "forwardPrincipal", "headers", "kind", "path", "tool", "url"],
      message,
    );
    if (record.forwardPrincipal !== undefined) {
      expectBoolean(
        record.forwardPrincipal,
        `${message} Expected "forwardPrincipal" to be a boolean.`,
      );
    }
    return {
      description: expectString(record.description, message),
      kind: "remote",
      path: record.path === undefined ? EVE_SESSION_ROUTE_PATH : expectString(record.path, message),
      tool: record.tool === undefined ? undefined : expectAgentToolExposure(record.tool, message),
      url: typeof record.url === "function" ? undefined : expectString(record.url, message),
    };
  }

  return { definition: value, kind: "local" };
}

export function assertRemoteAgentDefinitionHasNoLocalPackageEntries(
  source: LocalSubagentSourceRef,
): void {
  const manifest = source.manifest;
  const has = (kind: AgentSourceKind) => sourcesOf(manifest, kind).length > 0;
  const extraEntries = [
    has("connection") ? "connections/" : undefined,
    has("harness") ? "harness" : undefined,
    has("hook") ? "hooks/" : undefined,
    has("instructions") ? "instructions" : undefined,
    manifest.lib.length > 0 ? "lib/" : undefined,
    has("sandbox") ? "sandbox/" : undefined,
    manifest.sandboxWorkspaces.length > 0 ? "sandbox/workspace/" : undefined,
    has("schedule") ? "schedules/" : undefined,
    has("skill") ? "skills/" : undefined,
    manifest.subagents.length > 0 ? "subagents/" : undefined,
    has("tool") ? "tools/" : undefined,
  ].filter((entry) => entry !== undefined);
  if (extraEntries.length > 0) {
    throw new Error(
      `Remote subagent definition "${source.logicalPath}" cannot include local package entries. Remove unsupported entries: ${extraEntries.join(", ")}.`,
    );
  }
}
