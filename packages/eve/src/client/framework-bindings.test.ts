import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { createElement } from "react";
import { act, create as createRenderer } from "react-test-renderer";
import { createEffect, createRoot, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";

import type { ConversationState } from "#client/conversation-state.js";
import { testTurnFacts } from "#internal/testing/events.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/session-http.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { eventsOfLine, linesOf } from "#protocol/session-lines.js";
import {
  EVE_OBSERVATION_KEY_HEADER,
  localObservationKey,
} from "#protocol/descendant-observation.js";
import { useEveAgent as useReactAgent, type UseEveAgentReturn } from "#react/use-eve-agent.js";
import { useEveAgent as useSolidAgent } from "#solid/use-eve-agent.js";
import { useEveAgent as useSvelteAgent } from "#svelte/use-eve-agent.js";
import { useEveAgent as useVueAgent } from "#vue/use-eve-agent.js";

const SOLID_SERVER_BUILD = join(
  dirname(createRequire(import.meta.url).resolve("solid-js/package.json")),
  "dist/server.js",
);
const mounts: Array<() => void> = [];
vi.mock("svelte", () => ({
  onMount: (callback: () => () => void) => void mounts.push(callback()),
}));

afterEach(() => {
  mounts.splice(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function agent() {
  const log: string[] = [];
  const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let deliveries = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const url = new URL(String(request instanceof Request ? request.url : request));
    if ((init?.method ?? "GET") === "POST")
      return Response.json(
        { deliveryId: `d_${deliveries++}`, sessionId: "session_1", status: "accepted" },
        { status: 202 },
      );
    const start = Number(url.searchParams.get("startIndex") ?? "0");
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(log.slice(start).join("")));
          open.add(controller);
          init?.signal?.addEventListener("abort", () => {
            open.delete(controller);
            controller.error(init.signal?.reason);
          });
        },
      }),
      {
        headers: {
          [EVE_STREAM_TAIL_INDEX_HEADER]: String(log.length - 1),
          [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
        },
      },
    );
  });
  return {
    append(events: readonly SessionEvent[]) {
      const lines = events.flatMap((event) =>
        linesOf([event], "2026-10-10T00:00:00.000Z").map((line) => `${JSON.stringify(line)}\n`),
      );
      log.push(...lines);
      for (const controller of open) controller.enqueue(encoder.encode(lines.join("")));
    },
    get reading() {
      return open.size;
    },
  };
}

interface Mounted {
  readonly data: () => Pick<ConversationState, "messages"> | undefined;
  readonly send: (message: string) => Promise<unknown>;
  readonly finished: ReturnType<typeof vi.fn>;
  readonly dispose: () => void;
}

const bindings: Record<string, () => Mounted> = {
  react() {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const finished = vi.fn();
    let helpers: UseEveAgentReturn | undefined;
    function Probe() {
      helpers = useReactAgent({ baseUrl: "https://eve.test", onFinish: finished });
      return null;
    }
    let renderer: ReturnType<typeof createRenderer> | undefined;
    void act(() => {
      renderer = createRenderer(createElement(Probe));
    });
    return {
      data: () => helpers,
      dispose: () => void act(() => renderer?.unmount()),
      finished,
      send: (message) =>
        act(async () => {
          await helpers!.send(message);
        }),
    };
  },
  vue() {
    vi.stubGlobal("window", {});
    const finished = vi.fn();
    const scope = effectScope();
    const binding = scope.run(() =>
      useVueAgent({ baseUrl: "https://eve.test", onFinish: finished }),
    )!;
    return {
      data: () => ({ messages: binding.messages.value }),
      dispose: () => scope.stop(),
      finished,
      send: (message) => binding.send(message),
    };
  },
  solid() {
    const finished = vi.fn();
    let rendered: Pick<ConversationState, "messages"> = { messages: [] };
    const { binding, dispose } = createRoot((dispose) => {
      const binding = useSolidAgent({ baseUrl: "https://eve.test", onFinish: finished });
      createEffect(binding.messages, (messages) => {
        rendered = { messages };
      });
      return { binding, dispose };
    });
    return {
      data: () => rendered,
      dispose,
      finished,
      send: (message) => binding.send(message),
    };
  },
  svelte() {
    vi.stubGlobal("window", {});
    const finished = vi.fn();
    const binding = useSvelteAgent({ baseUrl: "https://eve.test", onFinish: finished });
    return {
      data: () => undefined,
      dispose: () => mounts.forEach((cleanup) => cleanup()),
      finished,
      send: (message) => binding.send(message),
    };
  },
};

describe("the framework bindings", () => {
  it.each(Object.keys(bindings))(
    "%s shows a sent message's reply, and stops reading the session once disposed",
    async (name) => {
      const server = agent();
      const binding = bindings[name]!();

      await binding.send("Weather?");
      await vi.waitFor(() => expect(server.reading).toBe(1));
      server.append(testTurnFacts(0, "Sunny.", ["d_0"]));
      await vi.waitFor(() => expect(binding.finished).toHaveBeenCalledTimes(1));
      const data = binding.data();
      if (data !== undefined)
        expect(data.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(server.reading).toBe(1);

      binding.dispose();
      await vi.waitFor(() => expect(server.reading).toBe(0));
    },
  );
});

describe("the React binding", () => {
  it("retains recursive followers across inline-policy renders, retries a silent disconnect, and cleans up", async () => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const at = "2026-10-10T00:00:00.000Z";
    const initialEvents = linesOf(
      [
        {
          type: "child.opened",
          data: {
            sessionId: "child",
            name: "reviewer",
            owner: { callId: "workflow" },
            stream: "/ignored",
          },
        },
      ],
      at,
    ).flatMap((line, position) => eventsOfLine(line, position, at));
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    const log = [...linesOf([{ type: "session.started", data: {} }], at)];
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      signals.push(init?.signal);
      const cursor = Number(url.searchParams.get("startIndex") ?? 0);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
            controller.enqueue(
              new TextEncoder().encode(
                log
                  .slice(cursor)
                  .map((line) => JSON.stringify(line) + "\n")
                  .join(""),
              ),
            );
          },
        }),
        {
          headers: {
            [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
            [EVE_STREAM_TAIL_INDEX_HEADER]: "1",
            [EVE_OBSERVATION_KEY_HEADER]: localObservationKey("child"),
          },
        },
      );
    });
    let helpers: UseEveAgentReturn | undefined;
    const finished = vi.fn();
    function Probe({ render }: { render: number }) {
      void render;
      helpers = useReactAgent({
        baseUrl: "https://eve.test",
        initialSession: { sessionId: "root", streamIndex: 0 },
        initialEvents,
        followAgents: () => true,
        onFinish: finished,
      });
      return null;
    }
    let renderer: ReturnType<typeof createRenderer> | undefined;
    try {
      await act(async () => {
        renderer = createRenderer(createElement(Probe, { render: 1 }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => renderer?.update(createElement(Probe, { render: 2 })));
      expect(request).toHaveBeenCalledTimes(1);
      expect(helpers?.agents.child?.observation).toMatchObject({
        status: "following",
        caughtUp: false,
      });
      controllers[0]!.close();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(helpers?.agents.child?.observation).toMatchObject({
        status: "interrupted",
        caughtUp: false,
      });
      log.push(...linesOf(testTurnFacts(0, "Reviewed.", ["review"]), at));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(helpers?.agents.child?.observation).toMatchObject({
        status: "caught-up",
        caughtUp: true,
        position: 2,
      });
      expect(finished).not.toHaveBeenCalled();
    } finally {
      await act(async () => renderer?.unmount());
    }
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    const count = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(count);
  });

  it("prepares its restored session when prewarm turns on, without replacing it", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    agent();
    const serve = vi.mocked(fetch).getMockImplementation()!;
    const preparations: string[] = [];
    vi.mocked(fetch).mockImplementation(async (request, init) => {
      if (init?.method === "POST" && init.body === undefined) {
        preparations.push(String(request));
        return Response.json({ ok: true, status: "ready" });
      }
      return await serve(request, init);
    });
    let helpers: UseEveAgentReturn | undefined;
    function Probe({ prewarm }: { readonly prewarm: boolean }) {
      helpers = useReactAgent({
        baseUrl: "https://eve.test",
        initialSession: { sessionId: "session_1", streamIndex: 0 },
        prewarm,
      });
      return null;
    }
    let renderer: ReturnType<typeof createRenderer> | undefined;
    await act(async () => {
      renderer = createRenderer(createElement(Probe, { prewarm: false }));
    });
    expect(preparations).toEqual([]);

    await act(async () => renderer?.update(createElement(Probe, { prewarm: true })));
    await vi.waitFor(() =>
      expect(preparations).toEqual(["https://eve.test/eve/v1/session/session_1"]),
    );
    expect(helpers?.session?.sessionId).toBe("session_1");
    await act(async () => renderer?.unmount());
  });
});

describe("the Solid binding", () => {
  it("resumes an attached session once mounted, and stops when disposed", async () => {
    const server = agent();
    const { dispose } = createRoot((dispose) => {
      useSolidAgent({
        baseUrl: "https://eve.test",
        initialSession: { sessionId: "session_1", streamIndex: 0 },
        resume: true,
      });
      return { dispose };
    });

    await vi.waitFor(() => expect(server.reading).toBe(1));
    dispose();
    await vi.waitFor(() => expect(server.reading).toBe(0));
  });

  it("shows a message sent before the component settles", () => {
    agent();
    let rendered: readonly string[] = [];
    const { dispose } = createRoot((dispose) => {
      const binding = useSolidAgent({ baseUrl: "https://eve.test" });
      void binding.send("Weather?").catch(() => {});
      createEffect(binding.messages, (messages) => {
        rendered = messages.map((message) => message.role);
      });
      return { dispose };
    });

    flush();
    expect(rendered).toEqual(["user"]);
    dispose();
  });

  it("throws a precise error without a reactive owner", () => {
    expect(() => useSolidAgent()).toThrow(
      "useEveAgent() must run inside a component or createRoot(). To share one conversation, create it inside createRoot() or a context provider.",
    );
  });

  it("claims the same hydration ids when server-rendered as in the browser", async () => {
    async function nextIdAfterBinding(build: "server" | "browser") {
      vi.resetModules();
      if (build === "server") vi.doMock("solid-js", () => import(SOLID_SERVER_BUILD));
      else vi.stubGlobal("window", {});
      const solid = await import("solid-js");
      expect("createDeepProxy" in solid).toBe(build === "server");
      const { useEveAgent } = await import("#solid/use-eve-agent.js");
      vi.doUnmock("solid-js");
      const id = solid.createRoot(
        (dispose) => {
          useEveAgent({ baseUrl: "https://eve.test" });
          const id = solid.getNextChildId(solid.getOwner()!);
          dispose();
          return id;
        },
        { id: "app" },
      );
      vi.unstubAllGlobals();
      return id;
    }

    expect(await nextIdAfterBinding("server")).toBe(await nextIdAfterBinding("browser"));
  });
});
