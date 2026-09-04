import {
  defineEval,
  type EveEvalContext,
  type EveEvalLiveTurn,
  type EveEvalSession,
  type EveEvalTurn,
} from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

const cases = [
  {
    parentActive: false,
    steering: true,
    description: "after the parent acknowledges delegation",
  },
  { parentActive: true, steering: true, description: "while the parent also has an active turn" },
  {
    parentActive: true,
    steering: false,
    description: "an unrelated follow-up preserves the work",
  },
] as const;

export default cases.map(({ parentActive, steering, description }) =>
  defineEval({
    description: `Background subagent steering: ${description}.`,
    // The parent chooses whether and how to redirect work. A scripted parent
    // would bake an implementation option into the acceptance test.
    tags: ["real-model", "background-steering"],
    timeoutMs: 240_000,
    async test(t) {
      const threadId = crypto.randomUUID();
      const memo = crypto.randomUUID();
      const original = `WORKER-RESULT:ORIGINAL:${memo}`;
      const steered = `WORKER-RESULT:STEERED:${memo}`;
      const expected = steering ? steered : original;
      const sessionId = await postMessage(
        t,
        threadId,
        [
          "Call steering-worker exactly once in the background with this exact message:",
          `ASSIGNMENT ${memo}`,
          "Acknowledge the receipt without reporting a result. Relay its final result verbatim when it completes.",
          "End this turn after acknowledging the receipt; the worker will keep running.",
        ].join("\n"),
      );

      try {
        const parent = t.target.watchTurn(sessionId);
        const acknowledged = await parent.result();
        acknowledged.expectOk();
        const parentTurns: EveEvalTurn[] = [acknowledged];
        let parentSession = parent.session;
        let pendingParent: EveEvalLiveTurn | undefined;
        // Admission can acknowledge before the child starts. Keep observing
        // from the cursor instead of assuming subagent.called precedes it.
        if (!parent.events.some((event) => event.type === "subagent.called")) {
          pendingParent = t.target.watchTurn(sessionId, {
            startIndex: streamIndex(parentSession),
          });
        }
        const called = await (pendingParent ?? parent).waitForEvent("subagent.called", {
          data: { name: "steering-worker" },
        });
        await t.require(
          called.data.agentId,
          satisfies((value) => typeof value === "string", "the worker has an agent id"),
        );
        const child = t.target.watchTurn(called.data.childSessionId);
        await child.waitForEvent("actions.requested", {
          data: {
            actions: (actions) =>
              actions.some(
                (action) =>
                  action.kind === "tool-call" && action.toolName === "wait-for-cancellation",
              ),
          },
        });

        let activeParent: EveEvalLiveTurn | undefined;
        if (parentActive) {
          // Establish a running child before holding another parent turn;
          // holding the launch turn can delay dispatch until its wait ends.
          await postMessage(t, threadId, "Please wait for cancellation.", "queue");
          activeParent =
            pendingParent ??
            t.target.watchTurn(sessionId, {
              startIndex: streamIndex(parentSession),
            });
          pendingParent = undefined;
          await activeParent.waitForEvent("actions.requested", {
            data: {
              actions: (actions) =>
                actions.some(
                  (action) =>
                    action.kind === "tool-call" && action.toolName === "wait-for-cancellation",
                ),
            },
          });
        }

        await t.require(
          child.events,
          satisfies(
            (events: typeof child.events) =>
              !events.some((event) =>
                ["turn.completed", "turn.cancelled", "turn.failed", "session.waiting"].includes(
                  event.type,
                ),
              ),
            "the follow-up arrives before the original child turn settles",
          ),
        );

        const followUpSessionId = await postMessage(
          t,
          threadId,
          steering
            ? "Steer the assignment you just delegated: use STEERED instead of ORIGINAL. Redirect that same worker now, preserving its original memo. This replaces the first request; do not start an independent assignment or report the original result. Stop your own wait, if any."
            : "Unrelated follow-up: stop your own wait and reply with SIDE-QUESTION-OK. Leave the existing background assignment running, and relay its result when it completes.",
        );
        await t.require(followUpSessionId, equals(sessionId));

        if (activeParent !== undefined) {
          const cancelled = await activeParent.result();
          cancelled.notEvent("turn.failed");
          cancelled.event("turn.cancelled", { count: 1 });
          parentTurns.push(cancelled);
          parentSession = activeParent.session;
        }
        // Observe through the result-bearing task wake, not just the parent's
        // acknowledgment of the steering message or an AGENT_BUSY failure wake.
        for (let attempt = 0; attempt < 6; attempt++) {
          const next =
            pendingParent ??
            t.target.watchTurn(sessionId, { startIndex: streamIndex(parentSession) });
          pendingParent = undefined;
          const turn = await next.result();
          parentTurns.push(turn);
          parentSession = next.session;
          if (
            turn.events.some(
              (event) =>
                event.type === "message.received" &&
                (JSON.stringify(event.data.message).includes(original) ||
                  JSON.stringify(event.data.message).includes(steered)),
            )
          ) {
            break;
          }
        }

        const calls = parentTurns.flatMap((turn) =>
          turn.events.filter((event) => event.type === "subagent.called"),
        );
        await t.require(
          calls,
          satisfies(
            (events: typeof calls) =>
              events.length > 0 &&
              events.every(
                (event) =>
                  event.data.name === "steering-worker" &&
                  event.data.agentId === called.data.agentId &&
                  event.data.childSessionId === called.data.childSessionId,
              ),
            "all delegations address the original worker session",
          ),
        );

        const firstChildTurn = await child.result();
        const childWasCancelled = firstChildTurn.events.some(
          (event) => event.type === "turn.cancelled",
        );
        if (steering && childWasCancelled) {
          // Also permits cancel-and-resume of the same child; no specific
          // control API or task-id lifetime is required by these assertions.
          const resumed = await t.target
            .watchTurn(called.data.childSessionId, { startIndex: streamIndex(child.session) })
            .result();
          resumed.expectOk();
          resumed.messageIncludes(expected);
        } else {
          firstChildTurn.expectOk();
          firstChildTurn.notEvent("turn.cancelled");
          firstChildTurn.messageIncludes(expected);
        }
        if (steering) {
          firstChildTurn.eventsSatisfy(
            "the original child never emits the superseded result",
            (events) =>
              !events.some(
                (event) =>
                  event.type === "message.completed" && event.data.message?.includes(original),
              ),
          );
        }

        // A queued follow-up extends observation beyond the first result wake
        // without cancelling a duplicate wake that is already pending.
        await postMessage(
          t,
          threadId,
          "Reply with exactly STEERING-CHECKPOINT. Do not repeat any earlier result or call tools.",
          "queue",
        );
        let checkpointReached = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          const next = t.target.watchTurn(sessionId, { startIndex: streamIndex(parentSession) });
          const turn = await next.result();
          parentTurns.push(turn);
          parentSession = next.session;
          turn.notEvent("subagent.called");
          if (turn.message?.includes("STEERING-CHECKPOINT")) {
            checkpointReached = true;
            break;
          }
        }
        t.check(checkpointReached, equals(true)).label("parent processes the queued checkpoint");

        const replies = parentTurns.flatMap((turn) =>
          turn.events.flatMap((event) =>
            event.type === "message.completed" && event.data.message !== null
              ? [event.data.message]
              : [],
          ),
        );
        t.check(replies.filter((message) => message.includes("WORKER-RESULT:")).length, equals(1));
        t.check(
          replies.some((message) => message.includes(expected)),
          equals(true),
        );
        if (steering)
          t.check(
            replies.some((message) => message.includes(original)),
            equals(false),
          );
        else
          t.check(
            replies.some((message) => message.includes("SIDE-QUESTION-OK")),
            equals(true),
          );
        for (const turn of parentTurns) {
          turn.notEvent("turn.failed");
          turn.notEvent("session.failed");
        }
      } finally {
        // Reset owns admitted background tasks; cancelling only the parent
        // turn would leave workers alive when a gate fails.
        try {
          const cleanup = await t.target.fetch(`/threads/${threadId}/new`, {
            method: "POST",
            signal: AbortSignal.timeout(10_000),
          });
          t.check(cleanup.ok, equals(true)).label("reset cleans up background work");
        } catch (error) {
          t.log(`Background steering cleanup failed: ${String(error)}`);
          t.check(false, equals(true)).label("reset cleans up background work");
        }
      }
    },
  }),
);

async function postMessage(
  t: EveEvalContext,
  threadId: string,
  message: string,
  turnPolicy: "queue" | "steer" = "steer",
): Promise<string> {
  const response = await t.target.fetch(`/threads/${threadId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, turnPolicy }),
    signal: t.signal,
  });
  if (!response.ok) throw new Error(`Posting steering message failed (${response.status}).`);
  const result = (await response.json()) as { sessionId?: string };
  if (typeof result.sessionId !== "string") throw new Error("Channel returned no session id.");
  return result.sessionId;
}

function streamIndex(session: EveEvalSession): number {
  const index = session.state?.streamIndex;
  if (index === undefined) throw new Error("Observed session has no stream cursor.");
  return index;
}
