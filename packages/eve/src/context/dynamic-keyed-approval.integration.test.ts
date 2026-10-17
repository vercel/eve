import { expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { buildDynamicTools } from "#context/build-dynamic-tools.js";
import {
  resolveDynamicTools,
  rebindMissingCompiledDynamicToolCallbacks,
} from "#context/dynamic-tool-lifecycle.js";
import {
  AuthKey,
  SessionIdKey,
  SessionKey,
  StaticModelReferenceKey,
  TurnDynamicToolMetadataKey,
} from "#context/keys.js";
import { resolveApprovalPolicy, type ApprovalContext } from "#approval/definition.js";
import { withApprovalGrants } from "#harness/approval-recheck.js";
import { turnStartedForResolvers } from "#harness/session-machine/change-points.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";
import { defineTool } from "#tools/definition.js";
import { defineDurableSchema } from "#tools/durable-schema.js";
import { once } from "#tools/approval/policies.js";
import {
  clearDurableDynamicCallbacks,
  stampDurableDynamicCallback,
} from "#tools/durable-callbacks.js";

const sessionId = "keyed-approval-rebind";
const event = turnStartedForResolvers(
  { sequence: 0, turnId: "turn_0" },
  {
    data: { cause: { deliveryId: "delivery_0" }, follows: null, turnId: "turn_0" },
    scope: { turnId: "turn_0" },
    type: "turn.started",
  },
);

function createContext() {
  const ctx = new ContextContainer();
  ctx.set(StaticModelReferenceKey, null);
  ctx.set(AuthKey, null);
  ctx.set(SessionIdKey, sessionId);
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId,
    turn: { id: "turn_0", sequence: 0 },
  });
  return ctx;
}

it("rebinds a keyed dynamic approval after losing its in-process callback registry", async () => {
  const resolver: ResolvedDynamicToolResolver = {
    eventNames: ["beforeTurn"],
    slug: "scoped",
    logicalPath: "tools/scoped.ts",
    sourceId: "test:scoped",
    sourceKind: "module",
    events: {
      beforeTurn: () => ({
        deploy: defineTool({
          description: "Deploy Alice's release",
          inputSchema: defineDurableSchema({
            closure: {},
            schema: () => z.object({ scope: z.string() }),
          }),
          approval: once({ key: (input) => input.scope }),
          execute: stampDurableDynamicCallback(() => "deployed", {
            callback: () => "deployed",
            closure: {},
          }),
        }),
      }),
    },
  };
  const ctx = createContext();
  await contextStorage.run(ctx, () =>
    resolveDynamicTools({ ctx, event, messages: [], resolvers: [resolver] }),
  );
  const persisted = JSON.stringify(ctx.require(TurnDynamicToolMetadataKey));
  clearDurableDynamicCallbacks(sessionId);

  const resumed = createContext();
  resumed.set(TurnDynamicToolMetadataKey, JSON.parse(persisted));
  try {
    await rebindMissingCompiledDynamicToolCallbacks({
      ctx: resumed,
      event,
      messages: [],
      resolvers: [resolver],
    });
    const [tool] = buildDynamicTools(resumed);
    if (tool?.approval === undefined) throw new Error("Expected rebound approval policy");
    const policy = resolveApprovalPolicy(tool.approval);
    const context: ApprovalContext = {
      abortSignal: new AbortController().signal,
      callId: "call-after-rebind",
      toolName: tool.name,
      toolInput: { scope: "dev" },
      getSandbox: async () => {
        throw new Error("Sandbox is not used by the approval policy");
      },
      session: {
        id: sessionId,
        auth: { current: null, initiator: null },
        turn: { id: "turn_0", sequence: 0 },
      },
    };
    expect(await policy(context)).toBe("user-approval");
    const grants = [{ toolName: tool.name, key: "dev", interactionId: "approved-before-rebind" }];
    expect(await policy(withApprovalGrants({ ...context }, grants))).toBe("not-applicable");
    expect(
      await policy(withApprovalGrants({ ...context, toolInput: { scope: "prod" } }, grants)),
    ).toBe("user-approval");
  } finally {
    clearDurableDynamicCallbacks(sessionId);
  }
});
