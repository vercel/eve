import { context as apiContext } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";

import { createAgentRun, otelTelemetry } from "#compiled/@vercel/agent-runs/index.js";
import { ContextContainer } from "#context/container.js";
import { defineTool } from "#tools/definition.js";

import {
  accumulate,
  memoryTools,
  memoryToolsDefinition,
  resolveMemoryScope,
} from "./definition.js";

const recalled = (turnId: string, overrides: { cleared?: number; scope?: string } = {}) => ({
  cleared: overrides.cleared ?? null,
  result: null,
  scope: overrides.scope ?? "alice",
  turnId,
});

describe("accumulate", () => {
  it("keeps earlier turns' recalls, and replaces what an id recalled before", () => {
    const first = accumulate(null, recalled("turn_0"), [
      { content: "Prefers Spanish.", itemKey: "language" },
      { content: "Asked about invoices." },
    ]);
    const second = accumulate(first as never, recalled("turn_1"), [
      { content: "Prefers French.", itemKey: "language" },
      { content: "Asked about refunds." },
    ]);

    expect(second.batches).toEqual([
      { messages: [{ content: "Asked about invoices." }], turnId: "turn_0" },
      {
        messages: [
          { content: "Prefers French.", id: "language" },
          { content: "Asked about refunds." },
        ],
        turnId: "turn_1",
      },
    ]);
  });

  it("leaves an id's message where it was when its content is the same", () => {
    const first = accumulate(null, recalled("turn_0"), [
      { content: "Prefers Spanish.", itemKey: "language" },
    ]);
    const second = accumulate(first as never, recalled("turn_1"), [
      { content: "Prefers Spanish.", itemKey: "language" },
    ]);

    expect(second.batches).toEqual(first.batches);
  });

  it("replaces a turn's recall when that turn recalls again", () => {
    const first = accumulate(null, recalled("turn_0"), [{ content: "Once." }]);
    const again = accumulate(first as never, recalled("turn_0"), [{ content: "Once." }]);

    expect(again.batches).toEqual([{ messages: [{ content: "Once." }], turnId: "turn_0" }]);
  });

  it("starts over after a clear or under another scope", () => {
    const first = accumulate(null, recalled("turn_0"), [{ content: "Alice's note." }]);
    const cleared = accumulate(first as never, recalled("turn_1", { cleared: 7 }), [
      { content: "After the clear." },
    ]);
    const bob = accumulate(first as never, recalled("turn_1", { scope: "bob" }), [
      { content: "Bob's note." },
    ]);

    expect(cleared.batches).toEqual([
      { messages: [{ content: "After the clear." }], turnId: "turn_1" },
    ]);
    expect(bob.batches).toEqual([{ messages: [{ content: "Bob's note." }], turnId: "turn_1" }]);
  });
});

describe("memoryToolsDefinition", () => {
  it("keeps a memory's tools under the ID of the tool file eve generated for them", () => {
    // Sessions hold their slot, memos, and the versions parked approvals compare under this ID.
    const definition = memoryToolsDefinition({
      logicalPath: "memory/profile.ts",
      offersTools: true,
      provider: { recall: {} },
      slot: "profile",
      sourceId: "memory/profile.ts",
      sourceKind: "module",
    } as never);

    expect(definition.id).toBe("tool::profile");
  });
});

describe("memoryTools", () => {
  it("names the turn's memory store on the span of each provider tool call", async () => {
    const memory = {
      logicalPath: "memory/profile.ts",
      provider: {
        recall: {},
        tools: async () => ({
          save: defineTool({
            description: "Save a note.",
            execute: async () => "saved",
            inputSchema: {},
          }),
        }),
      },
      scope: "alice",
      slot: "profile",
    };
    const ctx = {
      abortSignal: new AbortController().signal,
      channel: undefined,
      ctx: { get: () => undefined },
      memo: (_key: unknown, compute: () => unknown) => compute(),
      session: { auth: { current: null, initiator: null }, id: "session-1" },
    };
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const manager = new AsyncLocalStorageContextManager().enable();
    apiContext.setGlobalContextManager(manager);
    const tracing = createAgentRun({ telemetry: otelTelemetry({ provider }) });
    try {
      const tools = await memoryTools(memory as never, ctx as never);
      const scope = await resolveMemoryScope(memory as never, ctx as never);
      const turn = await tracing.turn({
        agentName: "support",
        capture: { emit: true, recordInputs: false, recordOutputs: false },
        identity: { conversationId: "c", runId: "r", turnId: "turn_0" },
        sequence: 0,
      });
      const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
      const call = await attempt.tool({ callId: "call-1", name: "profile__save" });

      const result = await call.run(() => tools!.profile__save!.execute({}, {} as never));
      await call.complete();
      await attempt.complete();
      await turn.complete();

      expect(result).toBe("saved");
      const span = exporter.getFinishedSpans().find((next) => next.name.includes("profile__save"));
      expect(span?.attributes).toMatchObject({
        "agent.memory.slot": "profile",
        "gen_ai.memory.store.id": scope!.key,
      });
    } finally {
      apiContext.disable();
      manager.disable();
      await tracing.shutdown();
    }
  });
});

describe("resolveMemoryScope", () => {
  it("lets a scope resolver key memory by the conversation's space", async () => {
    const conversation = {
      audience: "private",
      channel: { kind: "channel:slack", name: "slack" },
      environment: "production",
      principalType: "user",
      space: { id: "slack:T1:C1", type: "channel", workspaceId: "slack:T1" },
    } as const;

    const resolver = vi.fn(
      (ctx: { conversation?: typeof conversation }) => ctx.conversation?.space?.id ?? null,
    );
    const scope = await resolveMemoryScope(
      { namespace: "team", scope: resolver as never, slot: "notes" },
      {
        abortSignal: new AbortController().signal,
        channel: { kind: "channel:slack", metadata: {} },
        conversation,
        ctx: new ContextContainer() as never,
        session: { auth: { current: null, initiator: null }, id: "session-1" },
      },
    );

    expect(resolver).toHaveReturnedWith("slack:T1:C1");
    expect(scope).not.toBeNull();
  });
});
