import {
  expectAgentToolExposure,
  expectBoolean,
  expectObjectRecord,
  expectOnlyKnownKeys,
  expectString,
} from "#internal/authored-module.js";
import { EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import { assertDynamicSentinelKeys, isDynamicSentinel } from "#dynamic/definition.js";
import type { LocalSubagentSourceRef } from "#discover/manifest.js";
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

export function assertRemoteAgentDefinitionHasNoLocalPackageEntries(source: {
  readonly logicalPath: string;
  readonly manifest: Pick<
    LocalSubagentSourceRef["manifest"],
    | "compaction"
    | "connections"
    | "hooks"
    | "instructions"
    | "lib"
    | "sandbox"
    | "sandboxWorkspaces"
    | "schedules"
    | "skills"
    | "subagents"
    | "tools"
  >;
}): void {
  const manifest = source.manifest;
  const extraEntries = [
    manifest.compaction !== null ? "compaction.ts" : undefined,
    manifest.connections.length > 0 ? "connections/" : undefined,
    manifest.hooks.length > 0 ? "hooks/" : undefined,
    manifest.instructions.length > 0 ? "instructions" : undefined,
    manifest.lib.length > 0 ? "lib/" : undefined,
    manifest.sandbox !== null ? "sandbox/" : undefined,
    manifest.sandboxWorkspaces.length > 0 ? "sandbox/workspace/" : undefined,
    manifest.schedules.length > 0 ? "schedules/" : undefined,
    manifest.skills.length > 0 ? "skills/" : undefined,
    manifest.subagents.length > 0 ? "subagents/" : undefined,
    manifest.tools.length > 0 ? "tools/" : undefined,
  ].filter((entry) => entry !== undefined);
  if (extraEntries.length > 0) {
    throw new Error(
      `Remote subagent definition "${source.logicalPath}" cannot include local package entries. Remove unsupported entries: ${extraEntries.join(", ")}.`,
    );
  }
}
