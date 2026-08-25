import { describe, expect, it } from "vitest";

import { buildDynamicTools } from "#context/build-dynamic-tools.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  dispatchDynamicToolEvent,
  rebindMissingCompiledDynamicToolCallbacks,
} from "#context/dynamic-tool-lifecycle.js";
import { AuthKey, SessionIdKey, SessionKey, TurnMemoryLocksKey } from "#context/keys.js";
import { createMemoryToolDynamicDefinition } from "#context/memory-tools.js";
import { resolveApprovalPolicy } from "#public/definitions/approval.js";
import { defineTool } from "#public/definitions/tool.js";
import { defineMemory } from "#public/memory/index.js";
import { always } from "#public/tools/approval/index.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";
import { createMemoryLock } from "#shared/memory-state.js";

const turn = Object.freeze({ id: "turn_0", input: [], sequence: 0 });
const event = { data: { sequence: 0, turnId: "turn_0" }, type: "turn.started" as const };

function createContext(scope: string) {
  const auth = {
    attributes: {},
    authenticator: "test",
    principalId: "user_1",
    principalType: "user",
  };
  const ctx = new ContextContainer();
  ctx.set(AuthKey, auth);
  ctx.set(SessionIdKey, "session_1");
  ctx.set(SessionKey, {
    auth: { current: auth, initiator: auth },
    sessionId: "session_1",
    turn: { id: turn.id, sequence: turn.sequence },
  });
  ctx.set(TurnMemoryLocksKey, {
    profile: createMemoryLock({
      namespace: "app",
      scope,
      slot: "profile",
      turn,
      visibility: "scope",
    }),
  });
  return ctx;
}

function resolver(version: () => number): ResolvedDynamicToolResolver {
  const definition = defineMemory({
    description: "Manage the profile.",
    provider: {
      recall: async () => null,
      tools: async (context) => ({
        save: defineTool({
          approval: always(),
          description: "Save a field.",
          execute: async () => `${version()}:${String(context.memory.scope.value)}`,
          inputSchema: {},
        }),
      }),
    },
    scope: "unused",
  });
  const dynamic = createMemoryToolDynamicDefinition(definition, "profile");
  return {
    eventNames: ["turn.started"],
    events: dynamic.events as ResolvedDynamicToolResolver["events"],
    logicalPath: "tools/profile.ts",
    rebindMissingCallbacks: true,
    slug: "profile",
    sourceId: "eve:memory-wrapper:memory/profile.ts",
    sourceKind: "module",
  };
}

describe("memory provider tools", () => {
  it("qualifies provider tools, prepends the slot description, and rebinds latest code with the captured scope", async () => {
    let deployedVersion = 1;
    const ctx = createContext("user_1");
    const compiledResolver = resolver(() => deployedVersion);

    await contextStorage.run(
      ctx,
      async () =>
        await dispatchDynamicToolEvent({
          ctx,
          event,
          messages: [{ content: "hello", role: "user" }],
          resolvers: [compiledResolver],
        }),
    );
    const [first] = buildDynamicTools(ctx);
    expect(first).toMatchObject({
      description: "Manage the profile.\n\nSave a field.",
      name: "profile__save",
    });

    const registry = Reflect.get(globalThis, Symbol.for("eve:dynamic-tool-callbacks")) as Map<
      string,
      Map<string, unknown>
    >;
    registry.get("profile__save")?.clear();
    deployedVersion = 2;
    ctx.set(TurnMemoryLocksKey, createContext("user_2").require(TurnMemoryLocksKey));

    await contextStorage.run(
      ctx,
      async () =>
        await rebindMissingCompiledDynamicToolCallbacks({
          ctx,
          event,
          messages: [{ content: "new turn", role: "user" }],
          resolvers: [compiledResolver],
        }),
    );

    const [replayed] = buildDynamicTools(ctx);
    if (replayed?.execute === undefined) throw new Error("Expected replayed execute callback.");
    if (replayed.approval === undefined) throw new Error("Expected replayed approval callback.");
    await expect(
      resolveApprovalPolicy(replayed.approval)({
        approvedTools: new Set(),
        callId: "call_1",
        session: {
          auth: { current: null, initiator: null },
          id: "session_1",
          turn: { id: "turn_0", sequence: 0 },
        },
        toolName: "profile__save",
      } as never),
    ).resolves.toBe("user-approval");
    const output = await contextStorage.run(
      ctx,
      async () => await replayed.execute!({}, { messages: [], toolCallId: "call_1" }),
    );
    expect(output).toBe("2:user_1");
  });

  it("omits tools for a disabled slot or tools:false", async () => {
    const ctx = createContext("user_1");
    const definition = defineMemory({
      provider: {
        recall: async () => null,
        tools: async () => ({
          save: defineTool({ description: "Save.", execute: async () => null, inputSchema: {} }),
        }),
      },
      scope: "unused",
      tools: false,
    });
    const dynamic = createMemoryToolDynamicDefinition(definition, "profile");
    const result = await contextStorage.run(
      ctx,
      async () =>
        await dynamic.events["turn.started"]?.(event, {
          channel: {},
          messages: [],
          session: { auth: { current: null, initiator: null }, id: "session_1" },
        }),
    );

    expect(result).toBeNull();
  });
});
