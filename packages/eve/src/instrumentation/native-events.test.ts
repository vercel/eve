import { attemptIdempotencyKey } from "#instrumentation/lifecycle.js";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { eventsOf } from "#harness/publication.js";
import { cascade } from "#harness/session-machine/cascade.js";
import {
  currentView,
  enterSessionProjectionAt,
  nextLinePosition,
  recordPublishedLine,
} from "#harness/session-machine/current.js";
import type { InstrumentationEvent } from "#instrumentation/lifecycle.js";
import { createInstrumentationHandleEvent } from "#instrumentation/native-events.js";
import type { SessionEvent } from "#protocol/session-event.js";

const at = "2026-10-09T00:00:00.000Z";
const turn = { turnId: "turn_0" };
const scope = (runId: string) => ({ runId, turnId: "turn_0" });
const overloaded = { code: "MODEL_CALL_FAILED", message: "Overloaded" };

/**
 * Publishes each commit as the writer does, closing what its owners' ends hold, and collects what
 * instrumentation hears.
 */
function session(
  options: { readonly capturesContent?: boolean; readonly frameworkTools?: readonly string[] } = {},
) {
  const ctx = new ContextContainer();
  enterSessionProjectionAt(ctx, undefined);
  const heard: InstrumentationEvent[] = [];
  const handle = createInstrumentationHandleEvent({
    functionId: "assistant",
    handleEvent: async (publication) => {
      const facts = cascade(currentView(ctx), eventsOf(publication));
      recordPublishedLine(ctx, { at, facts }, nextLinePosition(ctx), facts);
    },
    hooks: {
      capturesContent: options.capturesContent ?? false,
      publish: async (event) => void heard.push(event),
    },
    isFrameworkTool: (name) => options.frameworkTools?.includes(name) === true,
    sessionId: "s",
  })!;
  return {
    ctx,
    heard,
    commit: (...facts: SessionEvent[]) => contextStorage.run(ctx, () => handle(facts)),
  };
}

const opening: SessionEvent[] = [
  { data: {}, type: "session.started" },
  {
    data: { cause: { hook: "h" }, follows: null, turnId: "turn_0" },
    scope: turn,
    type: "turn.started",
  },
  { data: { owner: turn, runId: "run_0" }, scope: scope("run_0"), type: "model.requested" },
] as SessionEvent[];

function started(runId: string, attempt: number): SessionEvent {
  return { data: { attempt, modelId: "m", runId }, scope: scope(runId), type: "model.started" };
}

describe("step attempts from the stream", () => {
  it("ends each attempt of a run as its facts do, scoped from the run's row", async () => {
    const { commit, heard } = session();
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit({
      data: { attempt: 0, error: overloaded, runId: "run_0" },
      scope: scope("run_0"),
      type: "model.retried",
    });
    await commit(started("run_0", 1));
    await commit({
      data: { outcome: "completed", runId: "run_0" },
      scope: scope("run_0"),
      type: "model.settled",
    });

    expect(heard.filter((event) => event.type.startsWith("model."))).toMatchObject([
      {
        error: new Error("Overloaded"),
        idempotencyKey: "model-run:s:run_0:0",
        scope: {
          runId: "run_0",
          attempt: 0,
          functionId: "assistant",
        },
        type: "model.retried",
      },
      {
        outcome: "completed",
        idempotencyKey: "model-run:s:run_0:1",
        scope: { runId: "run_0", attempt: 1 },
        type: "model.settled",
      },
    ]);
  });

  it("counts a replacement run's attempts on from the run a retry gave up", async () => {
    const { commit, heard } = session();
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit({
      data: { outcome: "abandoned", runId: "run_0" },
      scope: scope("run_0"),
      type: "model.settled",
    });
    await commit({
      data: { owner: turn, runId: "run_1" },
      scope: scope("run_1"),
      type: "model.requested",
    });
    await commit(started("run_1", 1));
    await commit({
      data: { outcome: "completed", runId: "run_1" },
      scope: scope("run_1"),
      type: "model.settled",
    });

    expect(
      heard
        .filter((event) => event.type.startsWith("model."))
        .map((event) => ("scope" in event ? [event.type, attemptIdempotencyKey(event.scope)] : [])),
    ).toEqual([
      ["model.settled", "model-run:s:run_0:0"],
      ["model.settled", "model-run:s:run_1:1"],
    ]);
  });

  // A cancel stops the model call on purpose, so its attempt is cancelled, not failed (#5025).
  it("hears what a turn's end closes with it, as the writer commits it", async () => {
    const { commit, heard } = session();
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit({
      data: {
        callId: "call_0",
        capability: { kind: "tool", name: "wait" },
        input: {},
        owner: { runId: "run_0" },
      },
      scope: scope("run_0"),
      type: "call.requested",
    } as SessionEvent);
    await commit({
      data: { outcome: "cancelled", turnId: "turn_0" },
      scope: turn,
      type: "turn.settled",
    } as SessionEvent);

    expect(
      heard
        .filter((event) => event.type.startsWith("model.") || event.type.startsWith("call."))
        .map((event) => [event.type, "outcome" in event ? event.outcome : undefined]),
    ).toEqual([
      ["call.requested", undefined],
      ["call.settled", "interrupted"],
      ["model.settled", "cancelled"],
    ]);
  });

  it("fails the attempt a failed turn's end closes", async () => {
    const { commit, heard } = session();
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit({
      data: { error: overloaded, outcome: "failed", turnId: "turn_0" },
      scope: turn,
      type: "turn.settled",
    } as SessionEvent);

    expect(
      heard.flatMap((event) => (event.type === "model.settled" ? [event.outcome] : [])),
    ).toEqual(["interrupted"]);
  });
});

describe("calls and deliveries from the stream", () => {
  function agentCall(callId: string, remote?: true): SessionEvent {
    return {
      data: {
        callId,
        capability: { kind: "agent", name: "research", ...(remote && { remote }) },
        input: { message: "Find the 2025 report." },
        owner: { runId: "run_0" },
      },
      scope: scope("run_0"),
      type: "call.requested",
    } as SessionEvent;
  }

  it("reports a remote agent's call as one, and a subagent's as a subagent call", async () => {
    const { commit, heard } = session();
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit(agentCall("call_remote", true), agentCall("call_local"));

    expect(
      heard.flatMap((event) =>
        event.type === "call.requested" ? [[event.callId, event.capability]] : [],
      ),
    ).toEqual([
      ["call_remote", { kind: "agent", name: "research", remote: true }],
      ["call_local", { kind: "agent", name: "research" }],
    ]);
  });

  it("publishes delivery settlement in committed fact order without synthesizing a terminal", async () => {
    const { commit, heard } = session();
    await commit(...opening);
    await commit(
      { type: "delivery.admitted", data: { deliveryId: "d_0" } },
      { type: "delivery.consumed", data: { deliveryId: "d_0", turnId: "turn_0", parts: [] } },
    );
    await commit({
      data: { outcome: "completed", turnId: "turn_0" },
      scope: turn,
      type: "turn.settled",
    } as SessionEvent);

    expect(
      heard
        .filter(
          (event) =>
            (event.type === "delivery.settled" && event.outcome === "handled") ||
            event.type === "turn.settled",
        )
        .map((event) => [event.type, "turnId" in event ? event.turnId : undefined]),
    ).toEqual([
      ["turn.settled", "turn_0"],
      ["delivery.settled", "turn_0"],
    ]);
  });
});

function requested(
  callId: string,
  capability: { readonly kind: string; readonly name: string },
  runId = "run_0",
): SessionEvent {
  return {
    data: { callId, capability, input: { city: "Oslo" }, owner: { runId } },
    scope: scope(runId),
    type: "call.requested",
  } as SessionEvent;
}

function settled(callId: string, data: Record<string, unknown>, runId = "run_0"): SessionEvent {
  return { data: { callId, ...data }, scope: scope(runId), type: "call.settled" } as SessionEvent;
}

const approval = (interactionId: string, subject: { readonly callId: string }): SessionEvent =>
  ({
    data: {
      interactionId,
      request: { kind: "approval", options: [{ id: "approve", label: "Approve" }], prompt: "Go?" },
      subject,
    },
    scope: turn,
    type: "interaction.opened",
  }) as SessionEvent;

const of = (heard: readonly InstrumentationEvent[], prefix: string) =>
  heard.filter((event) => event.type.startsWith(prefix));

describe("session and turn endings", () => {
  it("names the turn that failed the session, and the latest turn otherwise", async () => {
    const failing = session();
    await failing.commit(...opening);
    await failing.commit({
      data: {
        cause: { turnId: "turn_0" },
        error: { code: "MODEL_CALL_FAILED", message: "Overloaded" },
        outcome: "failed",
      },
      type: "session.ended",
    } as SessionEvent);
    expect(of(failing.heard, "session.ended")).toMatchObject([
      {
        error: new Error("Overloaded"),
        outcome: "failed",
        turnId: "turn_0",
        type: "session.ended",
      },
    ]);

    const reset = session();
    await reset.commit(...opening);
    await reset.commit({
      data: { cause: { deliveryId: "d_reset" }, outcome: "completed" },
      type: "session.ended",
    } as SessionEvent);
    const [ended] = of(reset.heard, "session.ended");
    expect(ended).toMatchObject({ outcome: "completed", turnId: "turn_0" });
    expect(ended).not.toHaveProperty("error", expect.anything());
  });

  it("hears a session's end close its open turn first, with the turn's own outcome", async () => {
    const { commit, heard } = session();
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit({ data: { outcome: "completed" }, type: "session.ended" } as SessionEvent);

    expect(
      heard
        .filter((event) => !event.type.startsWith("model."))
        .map((event) => [event.type, "outcome" in event ? event.outcome : undefined]),
    ).toEqual([
      ["session.started", undefined],
      ["turn.started", undefined],
      ["turn.settled", "cancelled"],
      ["session.ended", "completed"],
    ]);
  });

  it("gives a failed turn its error, and a cancelled one none", async () => {
    const failed = session();
    await failed.commit(...opening);
    await failed.commit({
      data: { error: { code: "X", message: "Broke" }, outcome: "failed", turnId: "turn_0" },
      scope: turn,
      type: "turn.settled",
    } as SessionEvent);
    expect(of(failed.heard, "turn.settled")).toMatchObject([
      { error: new Error("Broke"), outcome: "failed", turnId: "turn_0" },
    ]);

    const cancelled = session();
    await cancelled.commit(...opening);
    await cancelled.commit({
      data: { outcome: "cancelled", turnId: "turn_0" },
      scope: turn,
      type: "turn.settled",
    } as SessionEvent);
    expect(of(cancelled.heard, "turn.settled")[0]).toMatchObject({ error: undefined });
  });
});

describe("calls", () => {
  it("names each capability's kind, and marks eve's own tools and skills as framework", async () => {
    const { commit, heard } = session({ frameworkTools: ["bash"] });
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit(
      requested("call_tool", { kind: "tool", name: "weather" }),
      requested("call_bash", { kind: "tool", name: "bash" }),
      requested("call_skill", { kind: "skill", name: "load_skill" }),
      requested("call_agent", { kind: "agent", name: "researcher" }),
    );

    expect(
      of(heard, "call.requested").map((event) =>
        event.type === "call.requested"
          ? [event.callId, event.capability.kind, event.frameworkTool]
          : [],
      ),
    ).toEqual([
      ["call_tool", "tool", false],
      ["call_bash", "tool", true],
      ["call_skill", "skill", true],
      ["call_agent", "agent", false],
    ]);
  });

  it("carries inputs and outputs only when the provider captures content", async () => {
    for (const capturesContent of [false, true]) {
      const { commit, heard } = session({ capturesContent });
      await commit(...opening);
      await commit(started("run_0", 0));
      await commit(requested("call_0", { kind: "tool", name: "weather" }));
      await commit(settled("call_0", { outcome: "completed", output: { temperature: 4 } }));
      await commit(requested("call_1", { kind: "tool", name: "weather" }));
      await commit(
        settled("call_1", {
          error: { code: "TOOL_FAILED", message: "No city", name: "QuotaError" },
          outcome: "failed",
        }),
      );

      const [request] = of(heard, "call.requested");
      const [completed, failed] = of(heard, "call.settled");
      expect(request).toMatchObject({ input: capturesContent ? { city: "Oslo" } : undefined });
      expect(completed).toMatchObject({
        output: capturesContent ? { temperature: 4 } : undefined,
      });
      // The failure's code reaches every provider; its message is content.
      expect(failed).toMatchObject({ errorCode: "TOOL_FAILED", outcome: "failed" });
      if (capturesContent) expect(failed).toHaveProperty("error.name", "QuotaError");
      expect(failed && "error" in failed ? failed.error : undefined).toEqual(
        capturesContent
          ? Object.assign(new Error("No city"), { code: "TOOL_FAILED", name: "QuotaError" })
          : undefined,
      );
    }
  });

  it("settles a retried attempt's calls under that attempt, before its replacement run's", async () => {
    // An attempt that announced calls gives its run up; eve can't tell whether they ran.
    const { commit, heard } = session();
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit(requested("call_0", { kind: "tool", name: "weather" }));
    await commit({
      data: { outcome: "abandoned", runId: "run_0" },
      scope: scope("run_0"),
      type: "model.settled",
    });
    await commit({
      data: { owner: turn, runId: "run_1" },
      scope: scope("run_1"),
      type: "model.requested",
    });
    await commit(started("run_1", 1));
    await commit(requested("call_1", { kind: "tool", name: "weather" }, "run_1"));

    expect(
      heard
        .filter((event) => event.type.startsWith("call.") || event.type.startsWith("model."))
        .map((event) => [
          event.type,
          "outcome" in event ? event.outcome : undefined,
          "scope" in event ? attemptIdempotencyKey(event.scope) : undefined,
        ]),
    ).toEqual([
      ["call.requested", undefined, "model-run:s:run_0:0"],
      ["call.settled", "abandoned", "model-run:s:run_0:0"],
      ["model.settled", "abandoned", "model-run:s:run_0:0"],
      ["call.requested", undefined, "model-run:s:run_1:1"],
    ]);
  });

  it("scopes a compaction run without inventing a turn or step", async () => {
    const { commit, heard } = session();
    await commit({ data: {}, type: "session.started" } as SessionEvent);
    await commit({
      data: { changeId: "change_0", kind: "compaction" },
      scope: { changeId: "change_0" },
      type: "context.started",
    } as SessionEvent);
    await commit({
      data: { owner: { changeId: "change_0" }, runId: "run_0" },
      scope: { changeId: "change_0", runId: "run_0" },
      type: "model.requested",
    } as SessionEvent);
    await commit({
      data: { attempt: 0, modelId: "m", runId: "run_0" },
      scope: { changeId: "change_0", runId: "run_0" },
      type: "model.started",
    } as SessionEvent);
    await commit({
      data: { outcome: "completed", runId: "run_0" },
      scope: { changeId: "change_0", runId: "run_0" },
      type: "model.settled",
    } as SessionEvent);

    expect(heard.map((event) => event.type)).toEqual(["session.started", "model.settled"]);
    expect(heard[1]).toMatchObject({ outcome: "completed", scope: { runId: "run_0", attempt: 0 } });
    expect((heard[1] as InstrumentationEvent<"model.settled">).scope.turnId).toBeUndefined();
  });
});

describe("interactions", () => {
  it("places an approval on its call's attempt and reports the chosen option", async () => {
    const { commit, heard } = session({ capturesContent: true });
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit(requested("call_0", { kind: "tool", name: "deploy" }));
    await commit(approval("i_0", { callId: "call_0" }));
    await commit({
      data: {
        cause: { responseId: "r_0" },
        interactionId: "i_0",
        outcome: "accepted",
        response: { optionId: "approve" },
      },
      scope: turn,
      type: "interaction.settled",
    } as SessionEvent);

    expect(of(heard, "interaction.")).toMatchObject([
      {
        call: { callId: "call_0", name: "deploy" },
        kind: "approval",
        request: { prompt: "Go?" },
        scope: { attempt: 0, runId: "run_0" },
        type: "interaction.opened",
      },
      { answer: { optionId: "approve" }, outcome: "accepted", type: "interaction.settled" },
    ]);
  });

  it("places a request about the turn on its latest run, and keeps sign-ins out", async () => {
    const { commit, heard } = session();
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit({
      data: { outcome: "completed", runId: "run_0" },
      scope: scope("run_0"),
      type: "model.settled",
    });
    await commit({
      data: { owner: turn, runId: "run_1" },
      scope: scope("run_1"),
      type: "model.requested",
    });
    await commit(started("run_1", 0));
    await commit({
      data: {
        interactionId: "i_budget",
        request: { kind: "budget", prompt: "Keep going?" },
        subject: { turnId: "turn_0" },
      },
      scope: turn,
      type: "interaction.opened",
    } as SessionEvent);
    await commit({
      data: {
        interactionId: "i_sign_in",
        request: { kind: "sign-in", prompt: "Sign in to Calendar" },
        subject: { turnId: "turn_0" },
      },
      scope: turn,
      type: "interaction.opened",
    } as SessionEvent);

    expect(of(heard, "interaction.")).toMatchObject([
      { interactionId: "i_budget", request: undefined, scope: { runId: "run_1" } },
    ]);
  });

  it("hears a withdrawn approval's end when its turn is cancelled, with no answer", async () => {
    const { commit, heard } = session({ capturesContent: true });
    await commit(...opening);
    await commit(started("run_0", 0));
    await commit(requested("call_0", { kind: "tool", name: "deploy" }));
    await commit(approval("i_0", { callId: "call_0" }));
    await commit({
      data: { outcome: "cancelled", turnId: "turn_0" },
      scope: turn,
      type: "turn.settled",
    } as SessionEvent);

    expect(
      heard
        .filter((event) => event.type !== "session.started" && event.type !== "turn.started")
        .map((event) => [event.type, "outcome" in event ? event.outcome : undefined]),
    ).toEqual([
      ["call.requested", undefined],
      ["interaction.opened", undefined],
      ["interaction.settled", "interrupted"],
      ["call.settled", "interrupted"],
      ["model.settled", "cancelled"],
      ["turn.settled", "cancelled"],
    ]);
    expect(of(heard, "interaction.settled")[0]).toMatchObject({ answer: undefined });
  });
});
