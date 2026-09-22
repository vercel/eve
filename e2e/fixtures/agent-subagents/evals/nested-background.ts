import type { MessageStreamEvent } from "eve/client";
import type { EveEvalContext } from "eve/evals";
import { equals } from "eve/evals/expect";
import {
  type Detector,
  NESTED_FINAL,
  nestedMessage,
} from "../agent/lib/nested-background-model.js";

export async function nestedBackgroundCompletion(t: EveEvalContext, target: Detector) {
  const key = crypto.randomUUID();
  const launch = (await t.send(nestedMessage("parent", key, target))).expectOk();
  launch.requireToolCall(target, { output: { status: "working" } });
  const detectorId = await childSession(t, launch.sessionId, target);
  const detector = (await t.target.watchTurn(detectorId).result()).expectOk();
  detector.requireToolCall("verification-worker", { output: { status: "working" } });
  detector.notEvent("subagent.completed");
  const workerId = await childSession(t, detectorId, "verification-worker");
  const workerLive = t.target.watchTurn(workerId);
  const workerStep = await workerLive.waitForEvent("step.started");
  await t.require(workerStep.data.modelId, equals("eve-mock/nested-background-completion"));
  const workerActions = await workerLive.waitForEvent("actions.requested");
  await t.require(
    workerActions.data.actions.map((action) =>
      action.kind === "tool-call" ? action.toolName : action.kind,
    ),
    equals(["verification_gate"]),
  );
  const gatePath = `/test/verification/${encodeURIComponent(workerId)}/${key}`;
  const gate = async (action: "ready" | "release") => {
    const response = await t.target.fetch(`${gatePath}/${action}`, {
      method: "POST",
      signal: t.signal,
    });
    await t.require(response.status, equals(200));
    return response.json();
  };

  // Acknowledged durable gate, not a sleep: the detector has yielded and
  // its nested worker cannot finish until the eval explicitly releases it.
  await t.require(await gate("ready"), equals({ status: "running" }));
  try {
    const pending = await snapshot(t, launch.sessionId);
    t.check(
      pending.filter((event) => event.type === "subagent.completed"),
      equals([]),
    ).label("yielding the detector does not complete the parent's delegated task");
  } finally {
    await t.require(await gate("release"), equals({ released: true }));
  }

  const worker = (await workerLive.result()).expectOk();
  worker.calledTool("verification_gate", { count: 1, status: "completed" });
  worker.messageIncludes(NESTED_FINAL);
  const detectorFinal = (
    await t.target
      .watchTurn(detectorId, {
        startIndex: detector.session.state.streamIndex,
      })
      .result()
  ).expectOk();
  detectorFinal.messageIncludes(NESTED_FINAL);
  detectorFinal.event("subagent.completed", {
    data: { subagentName: "verification-worker", output: NESTED_FINAL },
    count: 1,
  });

  const parentFinal = (
    await t.target
      .watchTurn(launch.sessionId, {
        startIndex: launch.session.state.streamIndex,
      })
      .result()
  ).expectOk();
  parentFinal.messageIncludes(NESTED_FINAL);
  parentFinal.event("subagent.completed", {
    data: { subagentName: target, output: NESTED_FINAL },
    count: 1,
  });

  const replay = await snapshot(t, launch.sessionId);
  await t.require(
    replay.flatMap((event) => (event.type === "subagent.completed" ? [event.data.output] : [])),
    equals([NESTED_FINAL]),
  );
  await t.require(
    replay.filter(
      (event) =>
        event.type === "message.completed" &&
        JSON.stringify(event.data.message).includes(NESTED_FINAL),
    ).length,
    equals(1),
  );
  t.noFailedActions();
  t.succeeded();
}

async function snapshot(t: EveEvalContext, sessionId: string) {
  const events: MessageStreamEvent[] = [];
  for await (const event of sessionEvents(t, sessionId, false)) events.push(event);
  return events;
}

async function childSession(t: EveEvalContext, sessionId: string, name: string) {
  for await (const event of sessionEvents(t, sessionId, true)) {
    if (event.type === "subagent.called" && event.data.name === name) {
      if (name === "remote-loopback" && event.data.remote === undefined) {
        throw new Error("Detector must be reached over the remote HTTP transport.");
      }
      return event.data.childSessionId;
    }
  }
  throw new Error(`No ${name} child was started.`);
}

// Follow delegation events across turn boundaries, or read only the durable
// tail for a negative assertion without waiting for a nonexistent next turn.
async function* sessionEvents(t: EveEvalContext, sessionId: string, follow: boolean) {
  const controller = new AbortController();
  const response = await t.target.fetch(
    `/eve/v1/session/${encodeURIComponent(sessionId)}/stream${follow ? "" : "?includeTailIndex=1"}`,
    { signal: AbortSignal.any([t.signal, controller.signal]) },
  );
  if (!response.ok || response.body === null) throw new Error(`Stream HTTP ${response.status}`);
  const header = response.headers.get("x-eve-stream-tail-index");
  if (!follow && header === null) throw new Error("Session stream has no durable tail index.");
  const tail = follow ? Infinity : Number(header);
  if (!follow && (!Number.isInteger(tail) || tail < -1))
    throw new Error("Invalid stream tail index.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let index = 0;
  try {
    while (follow || index <= tail) {
      const next = await reader.read();
      if (next.done) throw new Error("Session stream closed before the expected event.");
      buffer += next.value;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        yield JSON.parse(line) as MessageStreamEvent;
        index += 1;
        if (!follow && index > tail) return;
      }
    }
  } finally {
    controller.abort();
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
