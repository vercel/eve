import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { ContextContainer } from "#context/container.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import {
  dispatchDynamicSubagentEvent,
  getDynamicSubagentSelection,
} from "#context/dynamic-subagent-lifecycle.js";
import { StaticModelReferenceKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import type { DynamicResolveContext } from "#dynamic/definition.js";
import { mockModel } from "#evals/mock-model.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { defineAgent } from "#public/definitions/agent.js";
import { createSessionStartedEvent, createTurnStartedEvent } from "#protocol/message.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { resolveRuntimeModelReference } from "#runtime/agent/resolve-model.js";
import type { ResolvedDynamicSubagentResolver } from "#runtime/subagents/registry.js";
import {
  installLocalDevCapabilityEnvironment,
  withLocalDevRequestScope,
} from "#runtime/local-dev-capability.js";
import { stampDevelopmentClientAddress } from "#internal/nitro/dev-client-address.js";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/workflow/development-world-protocol.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineSelfModificationAgent, type SelfModificationAgentOptions } from "./agent.js";

const serverUrl = "http://127.0.0.1:3000";
const context: DynamicResolveContext = {
  channel: {},
  messages: [],
  model: null,
  session: { auth: { current: null, initiator: null }, id: "session" },
};

const SELF_MODIFICATION_NODE_ID = "subagents/self-modification";
const PARENT_SOURCE = {
  sourceKind: "module" as const,
  logicalPath: "agent.ts",
  sourceId: "agent-config",
};

function parentContext(reference: RuntimeModelReference): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(StaticModelReferenceKey, reference);
  return ctx;
}

function resolveContextFor(reference: RuntimeModelReference): DynamicResolveContext {
  return buildResolveContext(parentContext(reference), []);
}

/** Authored parent `agent.ts` in the root node, as the compiler records it. */
function authoredParent(model: LanguageModel, contextWindowTokens: number) {
  return {
    moduleMap: {
      nodes: {
        [ROOT_COMPILED_AGENT_NODE_ID]: {
          modules: {
            [PARENT_SOURCE.sourceId]: {
              default: defineAgent({ model, modelContextWindowTokens: contextWindowTokens }),
            },
          },
        },
      },
    },
    reference: {
      id: formatLanguageModelGatewayId(model),
      contextWindowTokens,
      source: PARENT_SOURCE,
    } satisfies RuntimeModelReference,
  };
}

function selfModificationResolver(
  agent: ReturnType<typeof defineSelfModificationAgent>,
): ResolvedDynamicSubagentResolver {
  return {
    eventNames: ["session.started", "turn.started"],
    events: agent.events as ResolvedDynamicSubagentResolver["events"],
    kind: "subagent",
    logicalPath: "self-modification/agent.ts",
    name: "self-modification",
    nodeId: SELF_MODIFICATION_NODE_ID,
    sourceId: "self-modification-agent",
    sourceKind: "module",
  };
}

function codexModel(): LanguageModel {
  return new MockLanguageModelV3({ provider: "codex.responses", modelId: "gpt-5.5" });
}

const savedEnvironment = { ...process.env };

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...savedEnvironment };
});

async function withDevHost<T>(callback: () => Promise<T>): Promise<T> {
  process.env.EVE_DEV = "1";
  const restore = installLocalDevCapabilityEnvironment({ appRoot: "/workspace/app", serverUrl });
  try {
    return await callback();
  } finally {
    restore();
  }
}

describe("self-modification local agent", () => {
  it("is available on an eve dev host without a request scope", async () => {
    await withDevHost(async () => {
      const agent = defineSelfModificationAgent({ config: { local: { enabled: true } } });

      await expect(agent.events["turn.started"]?.({}, context)).resolves.toMatchObject({
        model: "openai/gpt-6-luna-fast",
        reasoning: "high",
      });
    });
  });

  it.each<{
    label: string;
    options: SelfModificationAgentOptions;
    parent: DynamicResolveContext["model"];
    model: string;
    reasoning: string | undefined;
  }>([
    {
      label: "explicit model",
      options: { model: "anthropic/claude-sonnet-5" },
      parent: null,
      model: "anthropic/claude-sonnet-5",
      reasoning: undefined,
    },
    {
      label: "explicit reasoning",
      options: { reasoning: "low" },
      parent: null,
      model: "openai/gpt-6-luna-fast",
      reasoning: "low",
    },
    {
      label: "provider-default reasoning",
      options: { reasoning: "provider-default" },
      parent: null,
      model: "openai/gpt-6-luna-fast",
      reasoning: "provider-default",
    },
  ])(
    "preserves $label instead of forcing fallback reasoning",
    async ({ options, parent, model, reasoning }) => {
      await withDevHost(async () => {
        const agent = defineSelfModificationAgent({
          ...options,
          config: { local: { enabled: true } },
        });
        const resolved = await agent.events["turn.started"]?.({}, { ...context, model: parent });

        expect(resolved).toMatchObject({ model });
        expect(resolved).toHaveProperty("reasoning", reasoning);
      });
    },
  );

  it("returns the parent model selection without forcing fallback reasoning", async () => {
    await withDevHost(async () => {
      const agent = defineSelfModificationAgent({ config: { local: { enabled: true } } });
      const parent = resolveContextFor({ id: "openai/gpt-6-luna-fast" });
      const resolved = await agent.events["turn.started"]?.({}, parent);

      expect(resolved).toHaveProperty("model", parent.model);
      expect(resolved).toHaveProperty("reasoning", undefined);
    });
  });

  it.each([
    { label: "mockModel", model: mockModel("ok"), contextWindowTokens: 1_000_000 },
    { label: "codex", model: codexModel(), contextWindowTokens: 200_000 },
  ])(
    "runs on the authored $label parent model instead of rebuilding it from its id",
    async ({ model, contextWindowTokens }) => {
      // Unit tests otherwise swap authored models for eve's test mocks.
      vi.stubEnv("NODE_ENV", "production");
      await withDevHost(async () => {
        const logs = captureLogRecords();
        const parent = authoredParent(model, contextWindowTokens);
        const resolver = selfModificationResolver(
          defineSelfModificationAgent({ config: { local: { enabled: true } } }),
        );

        for (const event of [
          createSessionStartedEvent(),
          createTurnStartedEvent({ sequence: 1, turnId: "turn-1" }),
        ]) {
          const ctx = parentContext(parent.reference);
          await dispatchDynamicSubagentEvent({ ctx, event, messages: [], resolvers: [resolver] });

          // The stored reference crosses the durable boundary intact.
          const resumed = await deserializeContext(
            JSON.parse(JSON.stringify(serializeContext(ctx))) as Record<string, unknown>,
          );
          const selection = getDynamicSubagentSelection(resumed, SELF_MODIFICATION_NODE_ID);
          expect(selection?.agentConfig?.model).toEqual({
            ...parent.reference,
            sourceNodeId: ROOT_COMPILED_AGENT_NODE_ID,
          });
          // The child resolves the parent's authored module from its own node.
          await expect(
            resolveRuntimeModelReference(selection!.agentConfig!.model, {
              moduleMap: parent.moduleMap,
              nodeId: SELF_MODIFICATION_NODE_ID,
            }),
          ).resolves.toBe(model);
        }
        expect(logs.records).toEqual([]);
      });
    },
  );

  it("inherits a Gateway parent model id with its context window", async () => {
    await withDevHost(async () => {
      const logs = captureLogRecords();
      const ctx = parentContext({ id: "custom/unlisted-model", contextWindowTokens: 1_000_000 });
      const resolver = selfModificationResolver(
        defineSelfModificationAgent({ config: { local: { enabled: true } } }),
      );

      await dispatchDynamicSubagentEvent({
        ctx,
        event: createTurnStartedEvent({ sequence: 1, turnId: "turn-1" }),
        messages: [],
        resolvers: [resolver],
      });

      expect(
        getDynamicSubagentSelection(ctx, SELF_MODIFICATION_NODE_ID)?.agentConfig?.model,
      ).toEqual({ id: "custom/unlisted-model", contextWindowTokens: 1_000_000 });
      expect(logs.records).toEqual([]);
    });
  });

  it("keeps an explicit model without inheriting the parent model", async () => {
    await withDevHost(async () => {
      const agent = defineSelfModificationAgent({
        config: { local: { enabled: true } },
        model: "anthropic/claude-sonnet-5",
      });
      const parent = authoredParent(mockModel("ok"), 1_000_000);
      const resolved = await agent.events["turn.started"]?.(
        {},
        resolveContextFor(parent.reference),
      );

      expect(resolved).toHaveProperty("model", "anthropic/claude-sonnet-5");
      expect(resolved).not.toHaveProperty("modelContextWindowTokens");
    });
  });

  it("is available to a direct remote request on an eve dev host", async () => {
    await withDevHost(async () => {
      const secret = "test-secret";
      process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV] = secret;
      const headers = new Headers();
      stampDevelopmentClientAddress(headers, "203.0.113.7", secret);

      await withLocalDevRequestScope(new Request(serverUrl, { headers }), async () => {
        const agent = defineSelfModificationAgent({ config: { local: { enabled: true } } });

        await expect(agent.events["turn.started"]?.({}, context)).resolves.not.toBeNull();
      });
    });
  });

  it("does not expose the editor when eve dev facilities are absent", async () => {
    process.env.EVE_DEV = "1";
    const agent = defineSelfModificationAgent({ config: { local: { enabled: true } } });

    await expect(agent.events["turn.started"]?.({}, context)).resolves.toBeNull();
  });

  it("honors local.enabled: false even when eve dev facilities are available", async () => {
    await withDevHost(async () => {
      const agent = defineSelfModificationAgent({ config: { local: { enabled: false } } });

      await expect(agent.events["turn.started"]?.({}, context)).resolves.toBeNull();
    });
  });
});
