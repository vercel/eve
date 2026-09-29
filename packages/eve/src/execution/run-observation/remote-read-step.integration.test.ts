import { afterEach, describe, expect, it, vi } from "vitest";

import { deserializeContext } from "#context/serialize.js";
import { readRemoteObservationPage } from "#execution/run-observation/remote-read-step.js";
import { applyObservationPage, initialObservation } from "#execution/run-observation/state.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { stampTestEvent } from "#internal/testing/events.js";
import {
  createAgentStartedEvent,
  createTurnStartedEvent,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";

afterEach(() => vi.unstubAllGlobals());

describe("direct remote observation", () => {
  it("reads a parent-bound child with fresh authored credentials and advances only its cursor", async () => {
    const runtime = await createTestRuntime({ agent: { name: "remote-observation-parent" } });
    await runtime.run(async () => {
      const serializedContext = buildSerializedContext({ channelKind: "http" });
      const resolverId = "eve:dynamic-remote-agent//observation-research";
      const registryKey = Symbol.for("@workflow/core//registeredSteps");
      const globalRecord = globalThis as Record<symbol, Map<string, Function> | undefined>;
      const registry = globalRecord[registryKey] ?? new Map<string, Function>();
      globalRecord[registryKey] = registry;
      registry.set(resolverId, () => ({
        auth: async () => ({ headers: { authorization: "Bearer fresh" } }),
      }));
      await deserializeContext(serializedContext);
      const started = stampTestEvent(
        createAgentStartedEvent({
          callId: "call-1",
          name: "research",
          parentSessionId: "root-1",
          remote: { resolverId, url: "https://child.example" },
          sessionId: "child-1",
          taskId: "task-1",
          turnId: "turn-1",
        }),
      );
      const root = applyObservationPage(initialObservation("root-1"), "root-1", [
        { index: 0, event: started },
      ]);
      const source = root.sources["root-1/call-1/child-1"]!;
      const childEvent = stampTestEvent(
        createTurnStartedEvent({ turnId: "child-turn", sequence: 0 }),
      );
      const body = `${JSON.stringify(childEvent)}\n`;
      const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(
          "https://child.example/eve/v1/session/child-1/stream?startIndex=0&includeTailIndex=1",
        );
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body.slice(0, 12)));
              controller.enqueue(new TextEncoder().encode(body.slice(12)));
              controller.close();
            },
          }),
          { headers: { [EVE_STREAM_VERSION_HEADER]: "26", [EVE_STREAM_TAIL_INDEX_HEADER]: "0" } },
        );
      });
      vi.stubGlobal("fetch", fetcher);
      const page = await readRemoteObservationPage({
        rootSessionId: "root-1",
        serializedContext,
        source,
      });
      expect(page).toMatchObject({ capturedTail: 0, outcome: "caught-up" });
      expect(page.records).toEqual([{ index: 0, event: childEvent }]);
      const observed = applyObservationPage(root, source.key, page.records);
      expect(observed.sources[source.key]?.nextIndex).toBe(1);
      expect(observed.sources["root-1"]?.nextIndex).toBe(1);
      expect(observed.sources["root-1"]?.conversation.agents["child-1"]?.observation).toMatchObject(
        {
          status: "following",
        },
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { headers: { [EVE_STREAM_VERSION_HEADER]: "26" } })),
      );
      await expect(
        readRemoteObservationPage({ rootSessionId: "root-1", serializedContext, source }),
      ).rejects.toThrow(/captured tail/);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(body, {
              headers: { [EVE_STREAM_VERSION_HEADER]: "26", [EVE_STREAM_TAIL_INDEX_HEADER]: "0" },
            }),
        ),
      );
      await expect(
        readRemoteObservationPage({
          rootSessionId: "root-1",
          serializedContext,
          source: { ...source, nextIndex: 2 },
        }),
      ).rejects.toThrow(/behind the saved cursor/);
      registry.delete(resolverId);
      await expect(
        readRemoteObservationPage({
          rootSessionId: "other-root",
          serializedContext,
          source,
        }),
      ).rejects.toThrow(/direct-child binding/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  it("returns only complete records when a captured remote page ends mid-record", async () => {
    const runtime = await createTestRuntime({ agent: { name: "remote-observation-partial" } });
    await runtime.run(async () => {
      const resolverId = "eve:dynamic-remote-agent//partial-research";
      const registryKey = Symbol.for("@workflow/core//registeredSteps");
      const globalRecord = globalThis as Record<symbol, Map<string, Function> | undefined>;
      const registry = globalRecord[registryKey] ?? new Map<string, Function>();
      globalRecord[registryKey] = registry;
      registry.set(resolverId, () => ({}));
      try {
        const serializedContext = buildSerializedContext({ channelKind: "http" });
        const started = stampTestEvent(
          createAgentStartedEvent({
            callId: "call-2",
            name: "research",
            parentSessionId: "root-2",
            remote: { resolverId, url: "https://child.example" },
            sessionId: "child-2",
            turnId: "turn-2",
          }),
        );
        const root = applyObservationPage(initialObservation("root-2"), "root-2", [
          { index: 0, event: started },
        ]);
        const source = root.sources["root-2/call-2/child-2"]!;
        const first = stampTestEvent(createTurnStartedEvent({ turnId: "first", sequence: 0 }));
        const incomplete = stampTestEvent(
          createTurnStartedEvent({ turnId: "second", sequence: 1 }),
        );
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(
                      new TextEncoder().encode(
                        `${JSON.stringify(first)}\n${JSON.stringify(incomplete).slice(0, 20)}`,
                      ),
                    );
                    controller.close();
                  },
                }),
                {
                  headers: {
                    [EVE_STREAM_VERSION_HEADER]: "26",
                    [EVE_STREAM_TAIL_INDEX_HEADER]: "1",
                  },
                },
              ),
          ),
        );
        const page = await readRemoteObservationPage({
          rootSessionId: "root-2",
          serializedContext,
          source,
        });
        expect(page).toEqual({
          capturedTail: 1,
          records: [{ index: 0, event: first }],
          outcome: "partial",
        });
        expect(
          applyObservationPage(root, source.key, page.records).sources[source.key]?.nextIndex,
        ).toBe(1);
      } finally {
        registry.delete(resolverId);
      }
    });
  });
});
