import { describe, expect, it } from "vitest";

import type { StoredLine } from "#protocol/session-events/envelope.js";
import {
  emptySessionView,
  emptyPreviews,
  foldEvents,
  foldLines,
  type ReceivedEvent,
} from "#protocol/session-projection/fold.js";
import { activeTurn, idle, reply } from "#protocol/session-projection/selectors.js";

const at = "2026-10-09T00:00:00.000Z";
const spent = { inputTokens: 10, outputTokens: 2 };

/** One turn: the message `deliveryId` asks, a run that replies, and its usage. */
function turnLines(index: number, options: { readonly opensSession?: boolean } = {}): StoredLine[] {
  const turnId = `turn_${index}`;
  const runId = `run_${index}`;
  const deliveryId = `d_${index}`;
  const scope = { runId, turnId };
  const commit = (...facts: unknown[]): StoredLine => ({ at, facts });
  const opening: unknown[] =
    options.opensSession === true ? [{ data: {}, type: "session.started" }] : [];
  return [
    commit(...opening, { data: { deliveryId }, type: "delivery.admitted" }),
    commit(
      {
        data: { cause: { deliveryId }, follows: index === 0 ? null : `turn_${index - 1}`, turnId },
        scope: { turnId },
        type: "turn.started",
      },
      { data: { deliveryId, parts: [], turnId }, type: "delivery.consumed" },
      { data: { owner: { turnId }, runId }, scope, type: "model.requested" },
    ),
    commit(
      {
        data: {
          kind: "text",
          partId: `p_${index}`,
          phase: "reply",
          runId,
          value: `Reply ${index}.`,
        },
        scope,
        type: "content.completed",
      },
      { data: { outcome: "completed", runId }, scope, type: "model.settled" },
      { data: { kind: "model", owner: { runId }, usage: spent }, scope, type: "usage.recorded" },
    ),
    commit(
      {
        data: { outcome: "completed", reply: [`p_${index}`], turnId },
        scope: { turnId },
        type: "turn.settled",
      },
      { data: { deliveryId, outcome: "handled", turnId }, type: "delivery.settled" },
    ),
  ];
}

function folded(lines: readonly StoredLine[], retention?: "operational") {
  const view = emptySessionView();
  foldLines(view, lines, 0, { retention });
  return view;
}

describe("the shared fold", () => {
  it("folds a turn into its tables, and the selectors read them", () => {
    const lines = turnLines(0, { opensSession: true });
    const running = folded(lines.slice(0, 2));
    expect(activeTurn(running)?.turnId).toBe("turn_0");
    expect(idle(running)).toBe(false);

    const view = folded(lines);
    expect(view.turns.turn_0).toMatchObject({ outcome: "completed", status: "settled" });
    expect(view.deliveries.d_0).toMatchObject({ outcome: "handled", status: "settled" });
    // Rows say where they began and ended, so a reader can order a close against an opening.
    expect(view.turns.turn_0).toMatchObject({ closedAt: 3, endedAt: at, introducedAt: 1 });
    expect(view.runs.run_0).toMatchObject({ closedAt: 2, introducedAt: 1 });
    expect(reply(view, "turn_0").map((part) => part.value)).toEqual(["Reply 0."]);
    expect(activeTurn(view)).toBeUndefined();
    expect(idle(view)).toBe(true);
    expect(view.usage.total).toMatchObject(spent);
    expect(view.position).toBe(lines.length);
  });

  it("preserves authored call labels through progress and settlement", () => {
    const view = emptySessionView();
    const previews = emptyPreviews();
    foldLines(
      view,
      [
        ...turnLines(0, { opensSession: true }).slice(0, 2),
        {
          at,
          facts: [
            {
              type: "call.requested",
              data: {
                callId: "c_0",
                owner: { runId: "run_0" },
                capability: { kind: "tool", name: "search", label: "Search the archive" },
              },
            },
          ],
        },
        {
          progress: {
            type: "call.progress",
            data: { callId: "c_0", output: "partial", label: "Searching" },
          },
        },
      ],
      0,
      { previews },
    );
    expect(view.calls.c_0?.capability.label).toBe("Search the archive");
    expect(previews.calls.c_0).toMatchObject({ output: "partial", label: "Searching" });
    foldLines(
      view,
      [
        {
          at,
          facts: [
            {
              type: "call.settled",
              data: {
                callId: "c_0",
                outcome: "completed",
                output: "found",
                label: "Found the document",
              },
            },
          ],
        },
      ],
      view.position,
      { previews },
    );
    expect(view.calls.c_0).toMatchObject({ label: "Found the document", output: "found" });
    expect(previews.calls.c_0).toBeUndefined();
  });

  it("answers a held turn with its last step's reply, not the text it went on after", () => {
    const [opening, request, interim] = turnLines(0, { opensSession: true });
    const scope = { runId: "run_1", turnId: "turn_0" };
    const resumed = (reply: boolean): StoredLine => ({
      at,
      facts: [
        { data: { owner: { turnId: "turn_0" }, runId: "run_1" }, scope, type: "model.requested" },
        ...(reply
          ? [
              {
                data: {
                  kind: "text",
                  partId: "p_final",
                  phase: "reply",
                  runId: "run_1",
                  value: "Done.",
                },
                scope,
                type: "content.completed",
              },
            ]
          : []),
        { data: { outcome: "completed", runId: "run_1" }, scope, type: "model.settled" },
      ],
    });
    const answered = folded([opening!, request!, interim!, resumed(true)]);
    expect(reply(answered, "turn_0").map((part) => part.value)).toEqual(["Done."]);
    // A step that resumes after the tasks and writes nothing leaves the answer the turn gave.
    const quiet = folded([opening!, request!, interim!, resumed(false)]);
    expect(reply(quiet, "turn_0").map((part) => part.value)).toEqual(["Reply 0."]);
  });

  it("records a run's current attempt, each retry's start moving it on", () => {
    const lines = turnLines(0, { opensSession: true });
    const scope = { runId: "run_0", turnId: "turn_0" };
    const started = (attempt: number): StoredLine => ({
      at,
      facts: [{ data: { attempt, modelId: "m", runId: "run_0" }, scope, type: "model.started" }],
    });
    const retried: StoredLine = {
      at,
      facts: [
        {
          data: {
            attempt: 0,
            error: { code: "MODEL_CALL_FAILED", message: "429" },
            runId: "run_0",
          },
          scope,
          type: "model.retried",
        },
      ],
    };
    const view = folded([...lines.slice(0, 2), started(0), retried]);
    expect(view.runs.run_0).toMatchObject({ attempt: 0, status: "running" });
    expect(view.runs.run_0?.error).toBeUndefined();
    foldLines(view, [started(1)], 4);
    expect(view.runs.run_0).toMatchObject({ attempt: 1, status: "running" });
  });

  it("ends a row on an outcome a newer writer added", () => {
    const lines = turnLines(0, { opensSession: true });
    const [settled] = (lines[3] as { readonly facts: readonly { readonly data: object }[] }).facts;
    const newer = { ...settled!, data: { ...settled!.data, outcome: "handed-off" } };
    const view = folded([...lines.slice(0, 3), { at, facts: [newer] }]);
    expect(view.turns.turn_0).toMatchObject({ outcome: "handed-off", status: "settled" });
    expect(activeTurn(view)).toBeUndefined();
  });

  it("folds a line once, however often a reader replays it", () => {
    const lines = turnLines(0, { opensSession: true });
    const view = folded(lines);
    foldLines(view, lines.slice(2), 2);
    expect(view.usage.total).toMatchObject(spent);
  });

  it("keeps a long session's operational view to its open work", () => {
    const lines = [
      ...turnLines(0, { opensSession: true }),
      ...Array.from({ length: 20 }, (_, index) => turnLines(index + 1)).flat(),
    ];
    const view = folded(lines, "operational");

    // Only what the latest line touched survives; the session's usage still counts every turn.
    expect(Object.keys(view.turns)).toEqual(["turn_20"]);
    expect(Object.keys(view.runs).length).toBeLessThanOrEqual(1);
    expect(Object.keys(view.parts)).toEqual([]);
    expect(view.usage.total.inputTokens).toBe(21 * spent.inputTokens);
  });

  it("keeps a call's ancestors while the call outlives its run", () => {
    const [admitted, started] = turnLines(0, { opensSession: true });
    const scope = { runId: "run_0", turnId: "turn_0" };
    const lines: StoredLine[] = [
      admitted!,
      started!,
      {
        at,
        facts: [
          {
            data: {
              callId: "c_0",
              capability: { kind: "agent", name: "helper" },
              owner: { runId: "run_0" },
            },
            scope,
            type: "call.requested",
          },
          { data: { outcome: "completed", runId: "run_0" }, scope, type: "model.settled" },
        ],
      },
      { at, facts: [{ data: { deliveryId: "d_1" }, type: "delivery.admitted" }] },
      { at, facts: [{ data: { deliveryId: "d_2" }, type: "delivery.admitted" }] },
    ];
    const view = folded(lines, "operational");
    expect(view.calls.c_0?.status).toBe("requested");
    expect(view.runs.run_0?.status).toBe("settled");
    expect(view.turns.turn_0).toBeDefined();
  });

  it("keeps an idle task without the call that started it, so its payloads don't pile up", () => {
    const [admitted, started] = turnLines(0, { opensSession: true });
    const scope = { runId: "run_0", turnId: "turn_0" };
    const lines: StoredLine[] = [
      admitted!,
      started!,
      {
        at,
        facts: [
          {
            data: {
              callId: "c_0",
              capability: { kind: "agent", name: "helper" },
              input: { brief: "x".repeat(1000) },
              owner: { runId: "run_0" },
            },
            scope,
            type: "call.requested",
          },
          {
            data: { kind: "agent", name: "helper", startedBy: { callId: "c_0" }, taskId: "t_0" },
            type: "task.started",
          },
          { data: { callId: "c_0", taskId: "t_0" }, type: "call.started" },
          { data: { callId: "c_0", outcome: "completed", output: "done" }, type: "call.settled" },
          { data: { outcome: "completed", runId: "run_0" }, scope, type: "model.settled" },
          { data: { outcome: "completed", turnId: "turn_0" }, type: "turn.settled" },
        ],
      },
      ...turnLines(1).slice(0, 2),
      { at, facts: [{ data: { deliveryId: "d_2" }, type: "delivery.admitted" }] },
    ];
    const view = folded(lines, "operational");
    expect(view.tasks.t_0?.status).toBe("running");
    expect(view.calls.c_0).toBeUndefined();
  });

  it("keeps the latest turn's rows until the next turn starts, withholding large values", () => {
    const scope = { runId: "run_0", turnId: "turn_0" };
    const call = (callId: string, output: unknown): unknown[] => [
      {
        data: {
          callId,
          capability: { kind: "tool", name: "read" },
          input: {},
          owner: { runId: "run_0" },
        },
        scope,
        type: "call.requested",
      },
      { data: { callId, outcome: "completed", output }, scope, type: "call.settled" },
    ];
    const settledTurn: StoredLine[] = [
      ...turnLines(0, { opensSession: true }).slice(0, 2),
      { at, facts: [...call("small", "done"), ...call("large", "x".repeat(20_000))] },
      {
        at,
        facts: [{ data: { outcome: "completed", runId: "run_0" }, scope, type: "model.settled" }],
      },
      { at, facts: [{ data: { outcome: "completed", turnId: "turn_0" }, type: "turn.settled" }] },
      { at, facts: [{ data: { deliveryId: "d_1" }, type: "delivery.admitted" }] },
    ];
    const kept = folded(settledTurn, "operational");
    expect(kept.calls.small?.output).toBe("done");
    expect(kept.calls.large?.output).toBeUndefined();
    expect(kept.calls.large?.outputRef).toEqual({ mediaType: "application/json", size: 20_002 });
    expect(kept.runs.run_0?.status).toBe("settled");

    const next = folded(
      [...settledTurn, ...turnLines(1).slice(1, 2), { at, facts: [] }],
      "operational",
    );
    expect(next.calls.small).toBeUndefined();
    expect(next.runs.run_0).toBeUndefined();
  });

  it("folds a reader's events by line, holding back a line still arriving", () => {
    const [first] = turnLines(0, { opensSession: true });
    const events: ReceivedEvent[] = [
      {
        data: {},
        meta: { at, endOfLine: false, position: { index: 0, line: 0 } },
        type: "session.started",
      },
    ];
    const view = emptySessionView();
    expect(foldEvents(view, events)).toEqual(events);
    expect(view.session.status).toBe("new");

    const whole: ReceivedEvent[] = [
      ...events,
      {
        data: { deliveryId: "d_0" },
        meta: { at, position: { index: 1, line: 0 } },
        type: "delivery.admitted",
      },
    ];
    expect(first).toBeDefined();
    expect(foldEvents(view, whole)).toEqual([]);
    expect(view.session.status).not.toBe("new");
    expect(view.deliveries.d_0?.status).toBe("admitted");
  });
});
