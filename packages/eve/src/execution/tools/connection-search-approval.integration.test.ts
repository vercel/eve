import { afterEach, describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  SessionIdKey,
  StaticModelReferenceKey,
  StepDynamicToolMetadataKey,
} from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { buildDynamicTools } from "#context/build-dynamic-tools.js";
import { bindDynamicConnections } from "#execution/dynamic-connections.js";
import { createStepStartedEvent } from "#protocol/message.js";
import { defineOpenAPIConnection } from "#public/definitions/connections/openapi.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import type {
  ResolvedDynamicConnectionResolver,
  ResolvedDynamicToolResolver,
} from "#runtime/types.js";
import type { ApprovalResponseContext } from "#approval/definition.js";
import type { DynamicToolSet } from "#tools/dynamic.js";
import type { ToolContext } from "#tools/definition.js";
import { clearDurableDynamicCallbacks } from "#tools/durable-callbacks.js";
import connectionSearch from "#tools/framework/connection-search.js";

const sessionId = "connection-search-approval-resume";
const runtime = { agentId: "test-agent", eveVersion: "test" };

function notes() {
  return {
    notes: defineOpenAPIConnection({
      approval: {
        request: () => "user-approval",
        response: () => ({ status: "allowed" as const }),
      },
      baseUrl: "http://127.0.0.1:4555",
      description: "Caller-specific notes service.",
      spec: {
        info: { title: "Notes", version: "1.0.0" },
        openapi: "3.0.0",
        paths: {
          "/notes": {
            post: {
              operationId: "saveNote",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      properties: { note: { type: "string" } },
                      required: ["note"],
                      type: "object",
                    },
                  },
                },
                required: true,
              },
              responses: { 200: { description: "Saved" } },
              summary: "Save a note.",
            },
          },
        },
      },
    }),
  };
}

const dynamicConnectionResolver: ResolvedDynamicConnectionResolver = {
  eventNames: ["turn.started"],
  events: { "turn.started": notes },
  logicalPath: "agent/connections/notes.ts",
  slug: "notes",
  sourceId: "connections/notes",
  sourceKind: "module",
};

const connectionSearchResolver: ResolvedDynamicToolResolver = {
  eventNames: ["step.started"],
  events: connectionSearch.events as ResolvedDynamicToolResolver["events"],
  logicalPath: "tools/connection-search.ts",
  slug: "connection-search",
  sourceId: "eve:connection-search",
  sourceKind: "module",
};

function createContext() {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, sessionId);
  ctx.set(StaticModelReferenceKey, null);
  const registry = new ConnectionRegistryImpl([]);
  ctx.set(ConnectionRegistryKey, registry);
  return { ctx, registry };
}

async function discoverNotesTool(ctx: ContextContainer): Promise<void> {
  await contextStorage.run(ctx, async () => {
    const resolve = connectionSearch.events["step.started"]!;
    const tools = (await resolve(
      {},
      {
        channel: {},
        model: null,
        messages: [],
        session: { auth: { current: null, initiator: null }, id: sessionId },
      },
    )) as DynamicToolSet;
    await tools.connection_search!.execute(
      { connection: "notes", keywords: "save note" },
      {} as ToolContext,
    );
    await dispatchDynamicToolEvent({
      ctx,
      event: createStepStartedEvent({
        modelId: "test",
        sequence: 1,
        stepIndex: 1,
        turnId: "turn-1",
      }),
      messages: [],
      resolvers: [connectionSearchResolver],
    });
  });
}

afterEach(() => {
  clearDurableDynamicCallbacks(sessionId);
});

describe("connection_search approval response after turn-scoped rehydration", () => {
  it.each(["warm", "fresh"] as const)(
    "replays the approval policy for a turn.started connection in a %s process",
    async (process) => {
      const first = createContext();
      const firstLifecycle = bindDynamicConnections(first.ctx, {
        dynamicConnectionResolvers: [dynamicConnectionResolver],
      });
      await firstLifecycle.rehydrate(
        { sequence: 1, sessionStarted: true, stepIndex: 1, turnId: "turn-1" },
        runtime,
        false,
      );
      expect(first.registry.getConnectionNames()).toEqual(["notes"]);
      await discoverNotesTool(first.ctx);
      const persisted = first.ctx.get(StepDynamicToolMetadataKey);
      expect(persisted?.map((entry) => entry.name)).toContain("notes__saveNote");

      if (process === "fresh") clearDurableDynamicCallbacks(sessionId);
      const resumed = createContext();
      resumed.ctx.set(StepDynamicToolMetadataKey, persisted!);
      const resumedLifecycle = bindDynamicConnections(resumed.ctx, {
        dynamicConnectionResolvers: [dynamicConnectionResolver],
      });
      await resumedLifecycle.rehydrate(
        { sequence: 2, sessionStarted: true, stepIndex: 0, turnId: "" },
        runtime,
        true,
      );
      expect(resumed.registry.getConnectionNames()).toEqual([]);

      const tool = buildDynamicTools(resumed.ctx).find(
        (candidate) => candidate.name === "notes__saveNote",
      );
      const approval = tool?.approval;
      if (approval === undefined || typeof approval === "function") {
        throw new Error("Expected the discovered notes tool to have an approval response policy.");
      }
      await expect(
        contextStorage.run(resumed.ctx, () => approval.response!({} as ApprovalResponseContext)),
      ).resolves.toEqual({ status: "allowed" });
    },
  );
});
