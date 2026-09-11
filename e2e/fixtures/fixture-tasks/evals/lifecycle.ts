import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { equals } from "eve/evals/expect";
import type { LifecycleControlEvent } from "../agent/lib/lifecycle-control.js";
import { completedTaskIds } from "./batching.js";
import { requireSessionStreamIndex } from "./shared.js";

export function lifecycleDriver(t: EveEvalContext, key: string) {
  let index = 0;
  const controls: LifecycleControlEvent[] = [];
  const turns: EveEvalTurn[] = [];
  let streamIndex = 0;
  let sessionId: string;
  const taskIds = new Map<string, string>();

  async function post<T>(action: string, body: object): Promise<T> {
    const response = await t.target.fetch(
      `/eve/v1/task-lifecycle/${encodeURIComponent(sessionId)}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, ...body }),
        signal: t.signal,
      },
    );
    await t.require(response.status, equals(200));
    return (await response.json()) as T;
  }

  function record(turn: EveEvalTurn) {
    turns.push(turn);
    for (const call of turn.toolCalls) {
      if (call.name !== "lifecycle_task") continue;
      const marker = call.input.marker;
      const output = call.output;
      if (
        typeof marker !== "string" ||
        output === null ||
        typeof output !== "object" ||
        !("taskId" in output) ||
        typeof output.taskId !== "string"
      )
        throw new Error("Missing lifecycle task receipt.");
      taskIds.set(marker, output.taskId);
    }
    return turn;
  }

  async function nextTurn() {
    const live = t.target.watchTurn(sessionId, { startIndex: streamIndex });
    const turn = (await live.result()).expectOk();
    streamIndex = requireSessionStreamIndex(live.session, "Lifecycle parent");
    return record(turn);
  }

  return {
    turns,
    controls,
    taskIds,
    async start(message: string) {
      const turn = (await t.send(message)).expectOk();
      sessionId = turn.sessionId;
      streamIndex = requireSessionStreamIndex(t, "Lifecycle setup");
      return record(turn);
    },
    async gate(marker: "A" | "B" | "parent") {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const found = controls.find((event) => event.kind === "gate" && event.marker === marker);
        if (found !== undefined) return found;
        controls.push(await post<LifecycleControlEvent>("next", { index: index++ }));
      }
      throw new Error(`No ${marker} lifecycle gate acknowledgment.`);
    },
    async release(gate: LifecycleControlEvent) {
      if (gate.token === undefined) throw new Error("Missing fixture gate token.");
      await t.require(await post("release", { token: gate.token }), equals({ released: true }));
    },
    async settled(marker: "A" | "B", agent = false) {
      await t.require(
        await post("settled", { marker }),
        equals({
          marker,
          status: "completed",
          deliveries: agent ? ["agent-request", "agent-request", "completed"] : ["completed"],
        }),
      );
    },
    async active(gate: LifecycleControlEvent) {
      await t.require(await post("active", { token: gate.token }), equals({ status: "running" }));
    },
    async cancelHeldTurn(parent: LifecycleControlEvent) {
      if (parent.kind !== "gate" || parent.marker !== "parent" || parent.sessionId !== sessionId) {
        throw new Error("Cancellation must address this session's acknowledged parent gate.");
      }
      // Use the same FIFO session inbox as task wakes, never a private turn/gate hook.
      // Omit tasks: cancellation must not retire either background task's ownership.
      const response = await t.target.fetch(
        `/eve/v1/session/${encodeURIComponent(sessionId)}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ turnId: parent.turnId }),
          signal: t.signal,
        },
      );
      await t.require(response.status, equals(202));
      await t.require(await response.json(), equals({ ok: true, status: "accepted", sessionId }));
    },
    async parentGateCancelled(parent: LifecycleControlEvent) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const acknowledgement = controls.find(
          (event) => event.kind === "gate-cancelled" && event.marker === "parent",
        );
        if (acknowledgement !== undefined) {
          await t.require(
            acknowledgement,
            equals({
              kind: "gate-cancelled",
              marker: "parent",
              runId: parent.runId,
              sessionId: parent.sessionId,
              turnId: parent.turnId,
            }),
          );
          return;
        }
        controls.push(await post<LifecycleControlEvent>("next", { index: index++ }));
      }
      throw new Error("The cancelled parent gate did not acknowledge hook disposal.");
    },
    async enqueue(message: string) {
      const response = await t.target.fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, turnPolicy: "queue" }),
        signal: t.signal,
      });
      await t.require(response.status, equals(202));
      await response.body?.cancel();
    },
    nextTurn,
    async through(message: string, allowCompletions = false) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const turn = await nextTurn();
        if (!allowCompletions) await t.require(completedTaskIds(turn), equals([]));
        if (
          turn.events.some(
            (event) => event.type === "message.received" && event.data.message === message,
          )
        )
          return turn;
      }
      throw new Error("Lifecycle checkpoint message was not acknowledged.");
    },
    async report() {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const turn = await nextTurn();
        if (completedTaskIds(turn).length > 0) return turn;
      }
      throw new Error("Lifecycle cohort did not deliver a completion report.");
    },
  };
}

export function assertLifecycleUnion(
  t: EveEvalContext,
  driver: ReturnType<typeof lifecycleDriver>,
) {
  const completions = driver.turns.filter((turn) => completedTaskIds(turn).length > 0);
  const expected = [...driver.taskIds.values()].sort();
  t.check(
    driver.turns.flatMap((turn) => turn.toolCalls).filter((call) => call.name === "lifecycle_task")
      .length,
    equals(2),
  ).label("exactly two background launches, without replacement or duplicate tasks");
  t.check(
    completions.map((turn) => completedTaskIds(turn).sort()),
    equals([expected]),
  ).label("one completion turn containing exactly the union of both launch receipts");
  t.check(
    completions.flatMap((turn) => turn.events.filter((event) => event.type === "step.started"))
      .length,
    equals(1),
  ).label("no extra completion-driven model steps");
  const messages = completions.flatMap((turn) =>
    turn.events.filter(
      (event) => event.type === "message.completed" && event.data.message !== null,
    ),
  );
  t.check(messages.length, equals(1)).label("exactly one visible final report");
  const report = completions[0]?.message;
  if (report === undefined) throw new Error("Missing union report.");
  const parsed = JSON.parse(report) as { report: string; notifications: string[] };
  t.check(parsed.report, equals("LIFECYCLE-REPORT"));
  for (const marker of ["A", "B"]) {
    t.check(
      parsed.notifications.join("\n").split(`LIFECYCLE:${marker}`).length - 1,
      equals(1),
    ).label(`${marker} output appears exactly once in the final union`);
  }
}
