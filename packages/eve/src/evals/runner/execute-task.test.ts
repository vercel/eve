import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { executeTask } from "#evals/runner/execute-task.js";
import type { EveEval, EveEvalContext } from "#evals/types.js";
import { createEvalTargetHandle } from "#evals/target.js";
import { satisfies } from "#evals/expect/index.js";
import { z } from "zod";

const target = createEvalTargetHandle({
  capabilities: { devRoutes: true },
  client: new Client({ host: "https://eve.test" }),
  kind: "local",
  url: "https://eve.test",
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function createTestEval(test: (t: EveEvalContext) => unknown, id = "test-eval"): EveEval {
  return { _tag: "EveEval", id, test } as EveEval;
}

describe("executeTask", () => {
  it("exposes a sleep helper with a one-second default", async () => {
    vi.useFakeTimers();
    let settled = false;

    const execution = executeTask({
      client: new Client({ host: target.url }),
      target,
      evaluation: createTestEval(async (t) => {
        await t.sleep();
        settled = true;
      }, "sleep"),
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const { result } = await execution;

    expect(settled).toBe(true);
    expect(result.status).toBe("completed");
  });

  it("runs a scripted eval with HITL helpers", async () => {
    const server = createScriptedServer([
      {
        sessionId: "session_1",
        events: [
          turnStarted("turn_1"),
          inputRequested("turn_1", "approval_1", "bash"),
          turnCompleted("turn_1"),
          sessionWaiting(),
        ],
      },
      {
        sessionId: "session_1",
        events: [
          turnStarted("turn_2"),
          actionResult("turn_2", "bash", "approved"),
          messageCompleted("approved", "turn_2"),
          turnCompleted("turn_2"),
          sessionCompleted(),
        ],
      },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch);

    const { result } = await executeTask({
      client: new Client({ host: target.url }),
      target,
      evaluation: createTestEval(async (t) => {
        const parked = await t.send("run pwd");
        parked.calledTool("bash", { status: "pending", count: 1 });
        const request = t.requireInputRequest({
          display: "confirmation",
          input: { command: "pwd" },
          optionIds: ["approve", "deny"],
          prompt: /Approve/,
          toolName: "bash",
        });
        expect(request.requestId).toBe("approval_1");
        const approved = await t.respondAll("approve");
        approved.calledTool("bash", { status: "completed", count: 1 });
        t.calledTool("bash", { status: "completed", count: 1 });
      }, "approve"),
    });

    expect(result.output).toBe("approved");
    expect(result.status).toBe("completed");
    expect(result.derived.inputRequests.map((request) => request.requestId)).toEqual([
      "approval_1",
    ]);
    expect(result.sessions).toHaveLength(1);
    expect(server.posts.map((post) => post.body)).toEqual([
      { message: "run pwd" },
      {
        continuationToken: "eve:session_1",
        inputResponses: [{ optionId: "approve", requestId: "approval_1" }],
      },
    ]);
  });

  it("sends a single turn for input evals", async () => {
    const server = createScriptedServer([
      {
        sessionId: "session_1",
        events: [
          turnStarted("turn_1"),
          messageCompleted("case output", "turn_1"),
          turnCompleted("turn_1"),
          sessionCompleted(),
        ],
      },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch);

    const { result } = await executeTask({
      client: new Client({ host: target.url }),
      target,
      evaluation: createTestEval(async (t) => {
        await t.send("case prompt");
      }, "input-eval"),
    });

    expect(result.output).toBe("case output");
    expect(server.posts[0]?.body).toEqual({ message: "case prompt" });
  });

  it("captures independent sessions created by newSession", async () => {
    const server = createScriptedServer([
      {
        sessionId: "primary",
        events: [
          turnStarted("turn_1"),
          messageCompleted("primary done", "turn_1"),
          turnCompleted("turn_1"),
          sessionCompleted(),
        ],
      },
      {
        sessionId: "secondary",
        events: [
          turnStarted("turn_2"),
          messageCompleted("secondary done", "turn_2"),
          actionsRequested("turn_2", "get_weather"),
          turnCompleted("turn_2"),
          sessionCompleted(),
        ],
      },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch);

    const { result } = await executeTask({
      client: new Client({ host: target.url }),
      target,
      evaluation: createTestEval(async (t) => {
        await t.send("primary");
        await t.newSession().send("secondary");
      }, "multi-session"),
    });

    expect(result.sessionId).toBe("primary");
    expect(result.sessions?.map((session) => session.sessionId)).toEqual(["primary", "secondary"]);
    expect(result.events).toHaveLength(9);
    expect(result.derived.toolCalls.map((call) => call.sessionId)).toEqual(["secondary"]);
  });

  it("records assertions against individual turns without leaking other turns", async () => {
    const server = createScriptedServer([
      {
        sessionId: "session_1",
        events: [
          turnStarted("turn_1"),
          actionsRequested("turn_1", "alpha"),
          turnCompleted("turn_1"),
          sessionWaiting(),
        ],
      },
      {
        sessionId: "session_1",
        events: [
          turnStarted("turn_2"),
          messageCompleted("done", "turn_2"),
          turnCompleted("turn_2"),
          sessionCompleted(),
        ],
      },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch);

    const outcome = await executeTask({
      client: new Client({ host: target.url }),
      target,
      evaluation: createTestEval(async (t) => {
        const first = await t.send("first");
        const second = await t.send("second");
        expect(first.requireToolCall("alpha", { status: "pending" }).name).toBe("alpha");
        first.calledTool("alpha", { status: "pending", count: 1 });
        second.notCalledTool("alpha");
        t.calledTool("alpha", { status: "pending", count: 1 });
      }, "turn-scopes"),
    });

    expect(outcome.assertions).toHaveLength(4);
    expect(outcome.assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  it("snapshots session assertions when they are recorded", async () => {
    const server = createScriptedServer([
      {
        sessionId: "session_1",
        events: [
          turnStarted("turn_1"),
          actionsRequested("turn_1", "alpha", "call_1"),
          turnCompleted("turn_1"),
          sessionWaiting(),
        ],
      },
      {
        sessionId: "session_1",
        events: [
          turnStarted("turn_2"),
          actionsRequested("turn_2", "alpha", "call_2"),
          turnCompleted("turn_2"),
          sessionWaiting(),
        ],
      },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch);

    const outcome = await executeTask({
      client: new Client({ host: target.url }),
      target,
      evaluation: createTestEval(async (t) => {
        const session = t.newSession();
        await session.send("first");
        session.calledTool("alpha", { status: "pending", count: 1 });
        session.event("turn.started", { count: 1 });
        await session.send("second");
      }, "session-snapshot"),
    });

    expect(outcome.assertions).toHaveLength(2);
    expect(outcome.assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  it("records a required assertion and stops dependent control flow", async () => {
    let continued = false;
    const outcome = await executeTask({
      client: new Client({ host: target.url }),
      target,
      evaluation: createTestEval(async (t) => {
        await t.require(
          1,
          satisfies<number>((value) => value > 2, "greater than two"),
        );
        continued = true;
      }, "require"),
    });

    expect(continued).toBe(false);
    expect(outcome.error).toBeUndefined();
    expect(outcome.assertions[0]).toMatchObject({ passed: false, severity: "gate" });
  });

  it("records a failed required tool lookup without an execution error", async () => {
    const server = createScriptedServer([
      {
        sessionId: "session_1",
        events: [
          turnStarted("turn_1"),
          messageCompleted("done", "turn_1"),
          turnCompleted("turn_1"),
          sessionCompleted(),
        ],
      },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch);

    const outcome = await executeTask({
      client: new Client({ host: target.url }),
      target,
      evaluation: createTestEval(async (t) => {
        const turn = await t.send("run");
        turn.requireToolCall("missing");
      }, "required-tool"),
    });

    expect(outcome.error).toBeUndefined();
    expect(outcome.assertions).toEqual([
      expect.objectContaining({ name: "requireToolCall", passed: false, severity: "gate" }),
    ]);
  });

  it("captures an explicit skip without an execution error", async () => {
    const outcome = await executeTask({
      client: new Client({ host: target.url }),
      target,
      evaluation: createTestEval((t) => t.skip("dev routes unavailable"), "skip"),
    });

    expect(outcome.error).toBeUndefined();
    expect(outcome.skipReason).toBe("dev routes unavailable");
  });

  it("rejects a skip after an assertion has already been recorded", async () => {
    const outcome = await executeTask({
      client: new Client({ host: target.url }),
      target,
      evaluation: createTestEval((t) => {
        t.check(
          1,
          satisfies((value: number) => value === 1, "equals one"),
        );
        t.skip("too late");
      }, "late-skip"),
    });

    expect(outcome.skipReason).toBeUndefined();
    expect(outcome.error).toContain("skip() must be called before");
  });

  it("attaches to a target-created session and captures its stream", async () => {
    const server = createScriptedServer([], {
      streams: [
        {
          sessionId: "channel-session",
          events: [
            turnStarted("turn_1"),
            messageCompleted("channel done", "turn_1"),
            turnCompleted("turn_1"),
            sessionCompleted(),
          ],
        },
      ],
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch);

    const outcome = await executeTask({
      client: new Client({ host: target.url }),
      target,
      evaluation: createTestEval(async (t) => {
        const session = await t.target.attachSession("channel-session");
        session.succeeded();
        session.messageIncludes("channel done");
      }, "attach"),
    });

    const { result } = outcome;
    expect(result.output).toBe("channel done");
    expect(result.sessions?.map((session) => session.sessionId)).toEqual(["channel-session"]);
    expect(result.events.map((event) => event.type)).toContain("message.completed");
    expect(outcome.assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  it("uses structured turn data as the scoped and aggregate output", async () => {
    const server = createScriptedServer([
      {
        sessionId: "structured",
        events: [
          turnStarted("turn_1"),
          {
            type: "result.completed",
            data: {
              result: { count: 2, title: "Done" },
              sequence: 1,
              stepIndex: 0,
              turnId: "turn_1",
            },
          },
          turnCompleted("turn_1"),
          sessionCompleted(),
        ],
      },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch);

    const outcome = await executeTask({
      client: new Client({ host: target.url }),
      target,
      evaluation: createTestEval(async (t) => {
        const turn = await t.send({ message: "structured", outputSchema: { type: "object" } });
        turn.outputMatches(z.object({ count: z.number(), title: z.string() }));
        turn.outputEquals({ count: 2, title: "Done" });
      }, "structured-output"),
    });

    expect(outcome.result.output).toEqual({ count: 2, title: "Done" });
    expect(outcome.assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  it("captures a schedule-dispatch capability failure as the task error", async () => {
    // A throwing `test` body is caught by executeTask and surfaced as `error`
    // (executeEval turns it into a failed verdict) rather than rejecting.
    const targetWithoutDevRoutes = createEvalTargetHandle({
      capabilities: { devRoutes: false },
      client: new Client({ host: "https://eve.test" }),
      kind: "remote",
      url: "https://eve.test",
    });

    const { error } = await executeTask({
      client: new Client({ host: target.url }),
      target: targetWithoutDevRoutes,
      evaluation: createTestEval(async (t) => {
        await t.target.dispatchSchedule("heartbeat");
      }, "no-dev-routes-schedule"),
    });

    expect(error).toMatch(/requires a target with dev routes enabled/);
  });
});

function createScriptedServer(
  turns: readonly { events: readonly HandleMessageStreamEvent[]; sessionId: string }[],
  options: {
    readonly streams?: readonly {
      readonly events: readonly HandleMessageStreamEvent[];
      readonly sessionId: string;
    }[];
  } = {},
) {
  const pendingTurns = [...turns];
  const streamQueues = new Map<string, HandleMessageStreamEvent[][]>();
  const posts: Array<{ body: unknown; method: string; url: string }> = [];

  for (const stream of options.streams ?? []) {
    const queue = streamQueues.get(stream.sessionId) ?? [];
    queue.push([...stream.events]);
    streamQueues.set(stream.sessionId, queue);
  }

  return {
    posts,
    async fetch(request: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url =
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      const method = init?.method ?? "GET";

      if (method === "POST") {
        const next = pendingTurns.shift();
        if (next === undefined) {
          return Response.json({ error: "No scripted turn.", ok: false }, { status: 500 });
        }

        posts.push({ body: JSON.parse(String(init?.body)), method, url });
        const queue = streamQueues.get(next.sessionId) ?? [];
        queue.push([...next.events]);
        streamQueues.set(next.sessionId, queue);

        return Response.json(
          {
            continuationToken: `eve:${next.sessionId}`,
            ok: true,
            sessionId: next.sessionId,
          },
          { status: posts.length === 1 ? 202 : 200 },
        );
      }

      const sessionId = decodeURIComponent(new URL(url).pathname.split("/").at(-2) ?? "");
      const events = streamQueues.get(sessionId)?.shift();
      if (events === undefined) {
        return Response.json({ error: "No stream.", ok: false }, { status: 404 });
      }

      return streamResponse(events);
    },
  };
}

function streamResponse(events: readonly HandleMessageStreamEvent[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        controller.close();
      },
    }),
  );
}

function turnStarted(turnId: string): HandleMessageStreamEvent {
  return { data: { sequence: 0, turnId }, type: "turn.started" };
}

function turnCompleted(turnId: string): HandleMessageStreamEvent {
  return { data: { sequence: 3, turnId }, type: "turn.completed" };
}

function sessionWaiting(): HandleMessageStreamEvent {
  return { data: { wait: "next-user-message" }, type: "session.waiting" };
}

function sessionCompleted(): HandleMessageStreamEvent {
  return { type: "session.completed" };
}

function messageCompleted(message: string, turnId: string): HandleMessageStreamEvent {
  return {
    data: { finishReason: "stop", message, sequence: 1, stepIndex: 0, turnId },
    type: "message.completed",
  };
}

function inputRequested(
  turnId: string,
  requestId: string,
  toolName: string,
): HandleMessageStreamEvent {
  return {
    data: {
      requests: [
        {
          action: { callId: "call_1", input: { command: "pwd" }, kind: "tool-call", toolName },
          allowFreeform: false,
          display: "confirmation",
          options: [
            { id: "approve", label: "Approve" },
            { id: "deny", label: "Deny" },
          ],
          prompt: "Approve?",
          requestId,
        },
      ],
      sequence: 1,
      stepIndex: 0,
      turnId,
    },
    type: "input.requested",
  };
}

function actionResult(turnId: string, toolName: string, output: string): HandleMessageStreamEvent {
  return {
    data: {
      result: { callId: "call_1", kind: "tool-result", output, toolName },
      sequence: 1,
      status: "completed",
      stepIndex: 0,
      turnId,
    },
    type: "action.result",
  };
}

function actionsRequested(
  turnId: string,
  toolName: string,
  callId = "call_weather",
): HandleMessageStreamEvent {
  return {
    data: {
      actions: [{ callId, input: { city: "Lisbon" }, kind: "tool-call", toolName }],
      sequence: 2,
      stepIndex: 0,
      turnId,
    },
    type: "actions.requested",
  };
}
