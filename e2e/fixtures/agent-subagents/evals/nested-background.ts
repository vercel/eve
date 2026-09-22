import type { EveEvalContext, EveEvalLiveTurn, EveEvalTurn } from "eve/evals";
import { equals } from "eve/evals/expect";

type Detector = "agent" | "local-detector" | "remote-loopback";

export async function nestedBackgroundCompletion(t: EveEvalContext, target: Detector) {
  const key = crypto.randomUUID();
  const workerTask = `Alice needs a verification receipt. Call verification_gate once with key ${key}. When it returns, reply with its returned text verbatim and nothing else. The tool performs the verification; do not delegate it or invent a result.`;
  const detectorTask = `Coordinate Alice's verification by calling verification-worker once with this task: ${JSON.stringify(workerTask)}. While that background task is working, say "Verification is running." and finish your turn. When its completion arrives, reply with the worker's result verbatim and nothing else. Do not do the worker's task yourself or delegate to another agent.`;
  const parentTask = `Alice needs you to coordinate a verification through ${target}. Call ${target} once with this task: ${JSON.stringify(detectorTask)}. Use ordinary text output, without an output schema. While that background task is working, acknowledge that it is underway and finish your turn. When its completion arrives, reply with the detector's result verbatim and nothing else. Do not perform or redelegate the detector's task yourself.`;
  const sessions = new Set<string>();

  try {
    const parent = await t.session();
    sessions.add(parent.sessionId);
    const launch = (await parent.send(parentTask)).expectOk();
    launch.requireToolCall(target, { output: { status: "working" } });
    const parentNext = t.target.watchTurn(parent.sessionId, {
      startIndex: parent.state.streamIndex,
    });
    const detectorId = await childSession(launch, parentNext, target);
    sessions.add(detectorId);
    const detector = (await t.target.watchTurn(detectorId).result()).expectOk();
    detector.requireToolCall("verification-worker", { output: { status: "working" } });
    detector.messageIncludes("Verification is running.");
    detector.notEvent("subagent.completed");
    const detectorNext = t.target.watchTurn(detectorId, {
      startIndex: detector.session.state.streamIndex,
    });
    const workerId = await childSession(detector, detectorNext, "verification-worker");
    sessions.add(workerId);
    const workerLive = t.target.watchTurn(workerId);
    const workerActions = await workerLive.waitForEvent("actions.requested", {
      data: {
        actions: (actions) =>
          actions.some(
            (action) => action.kind === "tool-call" && action.toolName === "verification_gate",
          ),
      },
    });
    await t.require(
      workerActions.data.actions
        .filter((action) => action.kind === "tool-call" && action.toolName === "verification_gate")
        .map((action) => action.input),
      equals([{ key }]),
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

    // The detector has yielded, but its worker cannot finish before this gate opens.
    await t.require(await gate("ready"), equals({ status: "running" }));
    t.check(
      [...launch.events, ...parentNext.events].filter(
        (event) => event.type === "subagent.completed",
      ),
      equals([]),
    ).label("yielding the detector does not complete the parent's delegated task");
    const released = await gate("release");
    await t.require(released.released, equals(true));
    const result: string = released.result;
    await t.require(typeof result, equals("string"));
    // This receipt is generated at release and never appears in any model prompt.
    await t.require(result.startsWith("VERIFIED: "), equals(true));

    const worker = (await workerLive.result()).expectOk();
    worker.calledTool("verification_gate", { count: 1, status: "completed", output: result });
    worker.messageIncludes(result);
    const detectorFinal = (await detectorNext.result()).expectOk();
    detectorFinal.messageIncludes(result);
    detectorFinal.event("subagent.completed", {
      data: { subagentName: "verification-worker", output: result },
      count: 1,
    });
    const parentFinal = (await parentNext.result()).expectOk();
    parentFinal.messageIncludes(result);
    parentFinal.event("subagent.completed", {
      data: { subagentName: target, output: result },
      count: 1,
    });
    const observed = [...launch.events, ...parentFinal.events];
    await t.require(
      observed.flatMap((event) => (event.type === "subagent.completed" ? [event.data.output] : [])),
      equals([result]),
    );
    await t.require(
      observed.filter(
        (event) =>
          event.type === "message.completed" && JSON.stringify(event.data.message).includes(result),
      ).length,
      equals(1),
    );
    t.noFailedActions();
    t.succeeded();
  } finally {
    // Reset every known session even when setup fails or the eval signal has expired.
    await Promise.allSettled(
      [...sessions].map(async (sessionId) => {
        const response = await t.target.fetch(
          `/eve/v1/session/${encodeURIComponent(sessionId)}/reset`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: "Nested verification eval cleanup" }),
            signal: AbortSignal.timeout(5_000),
          },
        );
        await response.body?.cancel();
      }),
    );
  }
}

async function childSession(turn: EveEvalTurn, next: EveEvalLiveTurn, name: string) {
  const called =
    turn.events.find((event) => event.type === "subagent.called" && event.data.name === name) ??
    (await next.waitForEvent("subagent.called", { data: { name } }));
  if (called.type !== "subagent.called") throw new Error(`No ${name} child was started.`);
  if (name === "remote-loopback" && called.data.remote === undefined) {
    throw new Error("Detector must be reached over the remote HTTP transport.");
  }
  return called.data.childSessionId;
}
