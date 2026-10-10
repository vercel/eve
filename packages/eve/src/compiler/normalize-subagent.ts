import {
  expectAgentToolExposure,
  expectBoolean,
  expectFunction,
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
      readonly build?: { readonly externalDependencies?: readonly string[] };
      readonly defaultTools?: boolean;
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
  if (isDynamicSentinel(value)) {
    assertDynamicSentinelKeys(value, message, ["build", "defaultTools"]);
    const record = value as unknown as Record<string, unknown>;
    expectFunction(record.resolve, message);
    const build =
      record.build === undefined ? undefined : normalizeDynamicSubagentBuild(record.build, message);
    return {
      kind: "dynamic",
      ...(build === undefined ? {} : { build }),
      ...(record.defaultTools === undefined
        ? {}
        : { defaultTools: expectBoolean(record.defaultTools, message) }),
    };
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
  const extraEntries = [
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

function normalizeDynamicSubagentBuild(
  value: unknown,
  message: string,
): { readonly externalDependencies?: readonly string[] } {
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, ["externalDependencies"], message);
  if (record.externalDependencies === undefined) return {};
  if (!Array.isArray(record.externalDependencies)) throw new Error(message);
  return {
    externalDependencies: record.externalDependencies.map((entry) => expectString(entry, message)),
  };
}
