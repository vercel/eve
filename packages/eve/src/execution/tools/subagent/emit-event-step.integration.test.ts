import { beforeEach, expect, it, vi } from "vitest";

import { ContextContainer, loadContext } from "#context/container.js";
import { SessionIdKey, SessionKey, SessionTitleKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { emitSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";

vi.mock("#context/serialize.js", () => ({
  deserializeContext: vi.fn(),
  serializeContext: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

it.each([false, true])(
  "delivers completion to typed and wildcard hooks and releases the writer (hook fails: %s)",
  async (fails) => {
    const calls: string[] = [];
    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, "parent");
    ctx.set(SessionKey, {
      sessionId: "parent",
      auth: { current: null, initiator: null },
      turn: { id: "turn", sequence: 0 },
    });
    ctx.set(ChannelKey, {
      kind: "test",
      state: {},
      "subagent.completed"(_data, adapterCtx) {
        calls.push("adapter");
        adapterCtx.state = { completed: true };
      },
    });
    const hookRegistry = createRuntimeHookRegistry([
      {
        slug: "completion",
        logicalPath: "hooks/completion.ts",
        sourceId: "hooks/completion.ts",
        sourceKind: "module",
        exportName: undefined,
        events: {
          "subagent.completed": async (event, hookCtx) => {
            expect(hookCtx.session.id).toBe("parent");
            if (event.type !== "subagent.completed") throw new Error("Unexpected event type");
            expect(event.data.output).toBe("done");
            expect(loadContext()).toBe(ctx);
            calls.push("typed");
            if (fails) throw new Error("completion subscriber failed");
            ctx.set(SessionTitleKey, "Completed research");
          },
          "*": async (event) => {
            calls.push(`wildcard:${event.type}`);
          },
        },
      },
    ]);
    ctx.set(BundleKey, {
      graph: { root: {} },
      resolvedAgent: { config: {} },
      turnAgent: { id: "parent" },
      subagentRegistry: {},
      hookRegistry,
    } as CompiledBundle);
    vi.mocked(deserializeContext).mockResolvedValue(ctx);
    vi.mocked(serializeContext).mockImplementation((context) => ({
      title: context.get(SessionTitleKey),
      channelState: context.get(ChannelKey)?.state,
    }));
    const chunks: Uint8Array[] = [];
    const stream = new WritableStream<Uint8Array>({
      write(chunk) {
        calls.push("stream");
        chunks.push(chunk);
      },
    });
    const emitted = emitSubagentEventStep({
      event: {
        type: "subagent.completed",
        data: { callId: "call", subagentName: "research", output: "done" },
      },
      sessionWritable: stream,
      serializedContext: {},
      sessionState: createTestSessionState({ sessionId: "parent" }),
    });
    if (fails) {
      await expect(emitted).rejects.toThrow("completion subscriber failed");
      expect(calls).toEqual(["adapter", "stream", "typed"]);
    } else {
      await expect(emitted).resolves.toEqual({
        serializedContext: { title: "Completed research", channelState: { completed: true } },
      });
      expect(calls).toEqual(["adapter", "stream", "typed", "wildcard:subagent.completed"]);
    }
    expect(chunks).toHaveLength(1);
    expect(new TextDecoder().decode(chunks[0])).toContain('"type":"subagent.completed"');
    expect(stream.locked).toBe(false);
  },
);
