import {
  expectBoolean,
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
  expectString,
} from "#internal/authored-module.js";
import { EVE_SESSION_ROUTE_PATH } from "#protocol/routes.js";
import { serializeOutputSchema, type ToolSchemaSource } from "#shared/tool-schema.js";
import type { JsonObject } from "#shared/json.js";
import { isDynamicSentinel, type DynamicToolEventName } from "#shared/dynamic-tool-definition.js";
import type { LocalSubagentSourceRef } from "#discover/manifest.js";

const ALLOWED_DYNAMIC_SUBAGENT_EVENTS = new Set<DynamicToolEventName>([
  "session.started",
  "turn.started",
]);

export type NormalizedSubagentConfig =
  | { readonly kind: "local"; readonly definition: unknown }
  | {
      readonly build?: { readonly externalDependencies?: readonly string[] };
      readonly eventNames: readonly DynamicToolEventName[];
      readonly kind: "dynamic";
    }
  | {
      readonly description: string;
      readonly kind: "remote";
      readonly outputSchema?: JsonObject;
      readonly path: string;
      readonly url?: string;
    };

export function normalizeSubagentConfig(value: unknown, message: string): NormalizedSubagentConfig {
  if (isDynamicSentinel(value)) {
    const record = expectObjectRecord(value, message);
    expectOnlyKnownKeys(record, ["build", "events", "kind"], message);
    const rawEvents = expectObjectRecord(record.events, message);
    const eventNames: DynamicToolEventName[] = [];
    for (const [eventName, handler] of Object.entries(rawEvents)) {
      if (!ALLOWED_DYNAMIC_SUBAGENT_EVENTS.has(eventName as DynamicToolEventName)) {
        throw new Error(
          `${message} Dynamic subagents support only "session.started" and "turn.started" handlers.`,
        );
      }
      expectFunction(handler, message);
      eventNames.push(eventName as DynamicToolEventName);
    }
    const build =
      record.build === undefined ? undefined : normalizeDynamicSubagentBuild(record.build, message);
    return build === undefined
      ? { eventNames, kind: "dynamic" }
      : { build, eventNames, kind: "dynamic" };
  }

  if (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly kind?: unknown }).kind === "remote"
  ) {
    const record = expectObjectRecord(value, message);
    expectOnlyKnownKeys(
      record,
      ["auth", "description", "forwardPrincipal", "headers", "kind", "outputSchema", "path", "url"],
      message,
    );
    if (record.forwardPrincipal !== undefined) {
      expectBoolean(
        record.forwardPrincipal,
        `${message} Expected "forwardPrincipal" to be a boolean.`,
      );
    }
    const outputSchema = serializeOutputSchema(record.outputSchema as ToolSchemaSource | undefined);
    return {
      description: expectString(record.description, message),
      kind: "remote",
      outputSchema,
      path: record.path === undefined ? EVE_SESSION_ROUTE_PATH : expectString(record.path, message),
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
