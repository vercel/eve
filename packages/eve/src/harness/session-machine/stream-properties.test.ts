// Random streams over the fact grammar, as a producer might write them: each commit goes through
// the writer's cascade, the checker, and both retentions. The properties are the stream's
// promises: the writer is idempotent and its lines check, and an operational view answers what a
// complete one does. `EVE_STREAM_PROPERTY_RUNS` raises the number of streams.

import { describe, expect, it } from "vitest";

import { cascade } from "#harness/session-machine/cascade.js";
import { announceWaiting } from "#harness/session-machine/waiting.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import { copyView, emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import {
  activeTurn,
  activity,
  idle,
  openWork,
  waiting,
} from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Move = { readonly name: string; readonly facts: () => SessionEvent[] };

const f = (type: string, data: object): SessionEvent => ({ data, type }) as SessionEvent;

/** Moves enabled in `v`, the complete view, as a producer might make them. */
function moves(v: SessionView, ids: () => string): Move[] {
  const out: Move[] = [];
  const turn = activeTurn(v);
  const open = <T extends { status: string }>(rows: Record<string, T>, ...s: string[]) =>
    Object.values(rows).filter((r) => s.includes(r.status));
  const admitted = open(v.deliveries, "admitted");
  const runs = open(v.runs, "requested", "running");
  const calls = open(v.calls, "requested", "running");
  const interactions = open(v.interactions, "open");
  const responses = open(v.responses, "submitted", "admitted");
  const tasks = open(v.tasks, "running");

  out.push({
    facts: () => [f("delivery.admitted", { deliveryId: ids() })],
    name: "admit",
  });
  if (turn === undefined && admitted.length > 0) {
    const d = admitted[0]!;
    out.push({
      facts: () => {
        const turnId = `turn_${v.session.turnCount}`;
        return [
          f("turn.started", {
            cause: { deliveryId: d.deliveryId },
            follows: v.session.latestTurnId ?? null,
            turnId,
          }),
          f("delivery.consumed", { deliveryId: d.deliveryId, parts: [], turnId }),
        ];
      },
      name: "turn.start",
    });
  }
  if (turn !== undefined) {
    const t = turn.turnId;
    for (const d of admitted)
      out.push({
        facts: () => [f("delivery.consumed", { deliveryId: d.deliveryId, parts: [], turnId: t })],
        name: "steer",
      });
    if (!runs.some((r) => "turnId" in r.owner && r.owner.turnId === t))
      out.push({
        facts: () => [f("model.requested", { owner: { turnId: t }, runId: ids() })],
        name: "run.request",
      });
    for (const o of ["completed", "failed", "cancelled"])
      out.push({ facts: () => [f("turn.settled", { outcome: o, turnId: t })], name: `turn.${o}` });
    out.push({
      facts: () => [
        f("interaction.opened", {
          interactionId: ids(),
          request: { kind: "budget", prompt: "More?" },
          subject: { turnId: t },
        }),
      ],
      name: "ask.budget",
    });
  }
  for (const r of runs) {
    if (r.status === "requested")
      out.push({
        facts: () => [f("model.started", { attempt: 0, modelId: "m", runId: r.runId })],
        name: "run.start",
      });
    if (r.status === "running") {
      const a = r.attempt ?? 0;
      out.push({
        facts: () => [
          f("model.retried", { attempt: a, error: { code: "x", message: "x" }, runId: r.runId }),
          f("model.started", { attempt: a + 1, modelId: "m", runId: r.runId }),
        ],
        name: "run.retry",
      });
      out.push({
        facts: () => [
          f("call.requested", {
            callId: ids(),
            capability: { kind: "tool", name: "t" },
            input: {},
            owner: { runId: r.runId },
          }),
        ],
        name: "call.request",
      });
      out.push({
        facts: () =>
          [0, 1, 2].map(() =>
            f("call.requested", {
              callId: ids(),
              capability: { kind: "tool", name: "t" },
              input: {},
              owner: { runId: r.runId },
            }),
          ),
        name: "call.batch",
      });
      out.push({
        facts: () => [
          f("content.completed", {
            kind: "text",
            partId: ids(),
            phase: "reply",
            runId: r.runId,
            value: "hi",
          }),
        ],
        name: "content",
      });
      for (const o of ["completed", "abandoned", "failed", "interrupted"])
        out.push({
          facts: () => [f("model.settled", { outcome: o, runId: r.runId })],
          name: `run.${o}`,
        });
    }
  }
  const unasked = calls.filter(
    (c) =>
      c.status === "requested" &&
      !interactions.some((i) => "callId" in i.subject && i.subject.callId === c.callId),
  );
  if (unasked.length > 1)
    out.push({
      facts: () =>
        unasked.map((c) =>
          f("interaction.opened", {
            interactionId: ids(),
            request: { kind: "approval", prompt: "Ok?" },
            subject: { callId: c.callId },
          }),
        ),
      name: "ask.batch",
    });
  for (const c of calls) {
    const approval = interactions.find(
      (i) => "callId" in i.subject && i.subject.callId === c.callId,
    );
    if (c.status === "requested" && approval === undefined) {
      out.push({
        facts: () => [
          f("interaction.opened", {
            interactionId: ids(),
            request: { kind: "approval", prompt: "Ok?" },
            subject: { callId: c.callId },
          }),
        ],
        name: "ask.approval",
      });
      out.push({ facts: () => [f("call.started", { callId: c.callId })], name: "call.start" });
      out.push({
        facts: () => {
          const existing = tasks[0];
          const taskId = existing?.taskId ?? ids();
          return [
            ...(existing === undefined
              ? [
                  f("task.started", {
                    kind: "agent",
                    name: "a",
                    startedBy: { callId: c.callId },
                    taskId,
                  }),
                ]
              : []),
            f("call.started", { callId: c.callId, taskId }),
          ];
        },
        name: "call.task",
      });
    }
    if (c.status === "running") {
      for (const o of ["completed", "failed"])
        out.push({
          facts: () => [f("call.settled", { callId: c.callId, outcome: o })],
          name: `call.${o}`,
        });
      out.push({
        facts: () => [
          f("call.requested", {
            callId: ids(),
            capability: { kind: "tool", name: "nested" },
            input: {},
            owner: { callId: c.callId },
          }),
        ],
        name: "call.nested",
      });
      out.push({
        facts: () => [
          f("interaction.opened", {
            interactionId: ids(),
            origin: { interactionId: ids(), sessionId: "child", call: { callId: c.callId } },
            request: { kind: "question", prompt: "?" },
            subject: { callId: c.callId },
          }),
        ],
        name: "ask.relayed",
      });
    }
  }
  for (const i of interactions) {
    out.push({
      facts: () => {
        const deliveryId = ids();
        return [
          f("delivery.admitted", { deliveryId }),
          f("response.submitted", {
            deliveryId,
            interactionId: i.interactionId,
            responseId: ids(),
          }),
        ];
      },
      name: "answer",
    });
    out.push({
      facts: () => [
        f("interaction.settled", { interactionId: i.interactionId, outcome: "withdrawn" }),
      ],
      name: "withdraw",
    });
  }
  for (const r of responses) {
    const i = v.interactions[r.interactionId];
    if (r.status === "submitted")
      out.push({
        facts: () => [f("response.admitted", { responseId: r.responseId })],
        name: "admit.resp",
      });
    if (i?.status === "open") {
      for (const o of ["accepted", "declined"])
        out.push({
          facts: () => {
            // A person's decision settles the approvals asked with it, in one commit.
            const own = (row: (typeof interactions)[number]) =>
              row.request.kind === "approval" && row.origin === undefined;
            const batch = own(i)
              ? interactions.filter((row) => own(row) && row.introducedAt === i.introducedAt)
              : [i];
            const facts = [f("response.settled", { outcome: "applied", responseId: r.responseId })];
            for (const row of batch) {
              facts.push(
                f("interaction.settled", {
                  ...(row === i && { cause: { responseId: r.responseId } }),
                  interactionId: row.interactionId,
                  outcome: o,
                }),
              );
              const call = "callId" in row.subject ? v.calls[row.subject.callId] : undefined;
              if (call?.status === "requested")
                facts.push(
                  o === "accepted"
                    ? f("call.started", {
                        callId: call.callId,
                        clearedBy: { interactionId: row.interactionId },
                      })
                    : f("call.settled", {
                        callId: call.callId,
                        outcome: "rejected",
                        cause: { interactionId: row.interactionId },
                      }),
                );
            }
            facts.push(f("delivery.settled", { deliveryId: r.deliveryId, outcome: "applied" }));
            return facts;
          },
          name: `decide.${o}`,
        });
    }
  }
  for (const t of tasks)
    out.push({
      facts: () => [
        f("interaction.opened", {
          interactionId: ids(),
          request: { kind: "question", prompt: "task?" },
          subject: { taskId: t.taskId },
        }),
      ],
      name: "ask.task",
    });
  for (const r of responses)
    if (
      !Object.values(v.interactions).some(
        (i) =>
          "responseId" in i.subject && i.subject.responseId === r.responseId && i.status === "open",
      )
    )
      out.push({
        facts: () => [
          f("interaction.opened", {
            interactionId: ids(),
            request: { kind: "sign-in", prompt: "sign in" },
            subject: { responseId: r.responseId },
          }),
        ],
        name: "ask.responder-sign-in",
      });
  const changes = open(v.changes, "running");
  if (changes.length === 0)
    out.push({
      facts: () => {
        const changeId = ids();
        return [
          f("context.started", {
            changeId,
            kind: "compaction",
            ...(turn && { turnId: turn.turnId }),
          }),
          f("model.requested", { owner: { changeId }, runId: ids() }),
        ];
      },
      name: "compact.start",
    });
  for (const c of changes)
    for (const o of ["completed", "failed"])
      out.push({
        facts: () => [f("context.settled", { changeId: c.changeId, kind: c.kind, outcome: o })],
        name: `compact.${o}`,
      });
  for (const t of tasks)
    out.push({
      facts: () => [f("task.ended", { outcome: "completed", taskId: t.taskId })],
      name: "task.end",
    });
  if (v.session.status === "open")
    out.push({
      facts: () => [f("session.ended", { outcome: "completed" })],
      name: "session.end",
    });
  return out;
}

/** What readers ask of a view, for comparing two retentions. */
function answers(view: SessionView) {
  const turnId = activeTurn(view)?.turnId;
  const waits = turnId === undefined ? undefined : waiting(view, turnId);
  const latest = view.session.latestTurnId;
  return {
    activity: activity(view).kind,
    idle: idle(view),
    open: Object.values(openWork(view, { session: true })).map((rows) => rows.length),
    reply: latest === undefined ? undefined : view.turns[latest]?.reply,
    turnId,
    waiting:
      waits === undefined
        ? undefined
        : waits.on === "person"
          ? waits.interactions.map((row) => row.interactionId)
          : waits.calls.map((row) => row.callId),
  };
}

const plain = (events: readonly SessionEvent[]) =>
  JSON.stringify(events.map(({ data, type }) => ({ data, type })));

/** Folds one random stream; returns the first broken promise, or `undefined`. */
function brokenPromise(seed: number, cascades = true): string | undefined {
  const random = rng(seed);
  let n = 0;
  const ids = () => `x${n++}`;
  const complete = emptySessionView();
  const operational = emptySessionView();
  const checker = createStreamChecker();
  let raw: SessionEvent[] = [
    f("session.started", {}),
    f("delivery.admitted", { deliveryId: ids() }),
  ];
  for (let step = 0; step < 120 && complete.session.status !== "ended"; step += 1) {
    const written = cascades ? cascade(operational, raw) : raw;
    if (cascades && plain(cascade(complete, raw)) !== plain(written)) return "cascade-retention";
    if (cascades && plain(cascade(operational, written)) !== plain(written))
      return "cascade-idempotent";
    const line = { at: "", facts: written };
    if (checker.check(line, complete.position).length > 0) return "checker";
    const before = [copyView(complete), copyView(operational)] as const;
    foldLine(complete, line, complete.position);
    foldLine(operational, line, operational.position, { retention: "operational" });
    if (JSON.stringify(answers(complete)) !== JSON.stringify(answers(operational)))
      return "selectors";
    if (
      plain(announceWaiting(before[0], complete)) !== plain(announceWaiting(before[1], operational))
    )
      return "announce";
    // Each kind of move is as likely as any other, so work under a turn accumulates.
    const options = moves(complete, ids).filter((m) => m.name !== "session.end" || random() < 0.02);
    const names = [...new Set(options.map((m) => m.name))].filter(
      (name) => !name.startsWith("turn.") || name === "turn.start" || random() < 0.15,
    );
    const name = names[Math.floor(random() * names.length)] ?? options[0]!.name;
    const candidates = options.filter((m) => m.name === name);
    raw = candidates[Math.floor(random() * candidates.length)]!.facts();
  }
  return undefined;
}

const RUNS = Number(process.env.EVE_STREAM_PROPERTY_RUNS ?? 20);

describe("the stream's promises, on random streams", () => {
  it("hold for the writer, the checker, and both retentions", () => {
    const broken = Array.from({ length: RUNS }, (_, seed) => brokenPromise(seed + 1)).flatMap(
      (finding, index) => (finding === undefined ? [] : [`seed ${index + 1}: ${finding}`]),
    );
    expect(broken).toEqual([]);
  });

  it("would catch a writer that didn't close what an owner's end leaves open", () => {
    const caught = Array.from({ length: 30 }, (_, seed) => brokenPromise(seed + 1, false));
    expect(caught).toContain("checker");
  });
});
