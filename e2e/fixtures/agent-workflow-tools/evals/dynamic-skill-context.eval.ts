import { defineEval, type EveEvalTargetHandle, type EveEvalTurn } from "eve/evals";
import { equals } from "eve/evals/expect";
import type { DynamicSkillContextObservation } from "../dynamic-skill-context-audit";

async function send(
  target: EveEvalTargetHandle,
  threadId: string,
  actor: "alice" | "bob",
  message: string,
): Promise<{ sessionId: string; environment: "development" | "preview" | "production" }> {
  const response = await target.fetch("/skill-context/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId, actor, message }),
  });
  if (!response.ok) throw new Error(`Skill context channel returned ${response.status}.`);
  return await response.json();
}

function expectedAuth(actor: "alice" | "bob") {
  return {
    principalId: actor === "alice" ? "workflow-e2e-user" : "workflow-e2e-reviewer",
    principalType: "user",
    authenticator: "e2e-fixture",
    issuer: "context-fixture",
    subject: actor,
    attributes: { actor, groups: ["reports", "reviewers"] },
  };
}

/** The child's reply: the agent tool's task result, or the waiting tool's result for `ctx.agent`. */
function readChildOutput(turn: EveEvalTurn, mode: "direct" | "waiting"): string {
  if (mode === "waiting") {
    const output = turn.toolCalls.find((call) => call.name === "blocking_agent")?.output;
    if (typeof output !== "string") throw new Error("The waiting tool's child reply is missing.");
    return output;
  }
  // The agent tool's call is the one a task serves.
  const served = new Set(
    turn.events.flatMap((event) =>
      event.type === "call.started" && event.data.taskId !== undefined ? [event.data.callId] : [],
    ),
  );
  // Agent calls aren't tool calls, so the call's settlement carries the child's reply.
  const settled = turn.events.find(
    (event) =>
      event.type === "call.settled" &&
      served.has(event.data.callId) &&
      event.data.outcome === "completed",
  );
  const output = settled?.type === "call.settled" ? settled.data.output : undefined;
  if (typeof output !== "string") throw new Error("The delegated child's reply is missing.");
  return output;
}

export default (["direct", "waiting"] as const).map((mode) =>
  defineEval({
    description: `${mode} delegation preserves session, channel, and conversation context in dynamic skills across parent turns.`,
    async test(t) {
      const threadId = crypto.randomUUID();
      const firstMessage = `Alice asks Bob to review a report. SUBAGENT-HOOKS:${mode}`;
      const followUp =
        "Bob reviews Alice's completed report and the resolver context. SUBAGENT-HOOKS:AUDIT DYNAMIC-SKILL-CONTEXT";
      const started = await send(t.target, threadId, "alice", firstMessage);
      const initial = await t.target.attach(started.sessionId).watch().result();
      initial.expectOk();
      const marker = mode === "direct" ? "Alice's hook audit" : "hook-audit:blocking";
      const childOutput = readChildOutput(initial, mode);
      t.check(childOutput.startsWith("WORKFLOW-CHILD:"), equals(true)).label(
        "child returned its report",
      );
      t.check(childOutput.includes(marker), equals(true)).label("child report includes its task");
      initial.messageIncludes(childOutput);

      const startIndex = initial.session.state.streamIndex;
      const resumed = await send(t.target, threadId, "bob", followUp);
      t.check(resumed.sessionId, equals(started.sessionId)).label(
        "same parent session after delegation",
      );
      const audit = await t.target.attach(resumed.sessionId, { startIndex }).watch().result();
      audit.expectOk();
      audit.calledTool("read_dynamic_skill_context", { count: 1, status: "completed" });
      const output = audit.toolCalls.find(
        (call) => call.name === "read_dynamic_skill_context",
      )?.output;
      if (!Array.isArray(output))
        throw new Error("Dynamic skill resolver observations are missing.");
      const observations = output as DynamicSkillContextObservation[];
      const firstTurnId = initial.events.find((event) => event.type === "turn.started")?.data
        .turnId;
      const auditTurnId = audit.events.find((event) => event.type === "turn.started")?.data.turnId;
      if (firstTurnId === undefined || auditTurnId === undefined)
        throw new Error("Parent turn coordinates are missing.");
      t.check(
        [...new Set(observations.map((entry) => entry.turnId))],
        equals([firstTurnId, auditTurnId]),
      ).label("dynamic skill evaluations see both parent turns");

      for (const [index, { context, turnId }] of observations.entries()) {
        const actor = turnId === auditTurnId ? "bob" : "alice";
        const label = `${turnId}[${index}]`;
        const expected: typeof context = {
          session: {
            id: started.sessionId,
            schedule: null,
            auth: {
              current: expectedAuth(actor),
              initiator: expectedAuth("alice"),
            },
            predecessor: null,
            // The parent agent's skill runs in the root session, which has no parent.
            parent: null,
          },
          channel: {
            kind: "channel:skill-context",
            continuationToken: `skill-context:${threadId}`,
            metadata: { topic: "delegated-report", labels: ["context-contract"] },
          },
          conversation: {
            audience: "private",
            channel: { kind: "channel:skill-context", name: "skill-context" },
            environment: started.environment,
            principalType: "user",
          },
        };
        for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
          t.check(context[key], equals(expected[key])).label(`${label}: ctx.${key}`);
        }
      }
      t.notEvent("session.ended", { data: { outcome: "failed" } });
      t.noFailedCalls();
      t.succeeded();
    },
  }),
);
