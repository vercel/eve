import { defineEval, type EveEvalTargetHandle } from "eve/evals";
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

export default (["direct", "waiting"] as const).map((mode) =>
  defineEval({
    description: `${mode} delegation preserves every dynamic-skill resolver context field across session start and later turns.`,
    async test(t) {
      const threadId = crypto.randomUUID();
      const firstMessage = `Alice asks Bob to review a report. SUBAGENT-HOOKS:${mode}`;
      const followUp =
        "Bob reviews Alice's completed report and the resolver context. SUBAGENT-HOOKS:AUDIT DYNAMIC-SKILL-CONTEXT";
      const started = await send(t.target, threadId, "alice", firstMessage);
      const initial = await t.target.watchTurn(started.sessionId).result();
      initial.expectOk();
      initial.calledTool("load_skill", { count: 1, status: "completed" });
      // Both delegation modes resolve inside the turn that started them.
      const marker = mode === "direct" ? "Alice's hook audit" : "hook-audit:blocking";
      const completion = initial.events.find((event) => event.type === "subagent.completed");
      if (completion?.type !== "subagent.completed")
        throw new Error("The delegated child's completion event is missing.");
      const childOutput = completion.data.output;
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
      const audit = await t.target.watchTurn(resumed.sessionId, { startIndex }).result();
      audit.expectOk();
      audit.calledTool("load_skill", { count: 1, status: "completed" });
      audit.calledTool("read_dynamic_skill_context", { count: 1, status: "completed" });
      const output = audit.toolCalls.find(
        (call) => call.name === "read_dynamic_skill_context",
      )?.output;
      if (!Array.isArray(output))
        throw new Error("Dynamic skill resolver observations are missing.");
      const observations = output as DynamicSkillContextObservation[];
      t.check(
        observations.map((entry) => entry.event),
        equals(["session.started", "turn.started", "turn.started"]),
      ).label("resolver runs once at session start and at every parent turn boundary");

      for (const [index, { context, event }] of observations.entries()) {
        const last = index === observations.length - 1;
        const label = `${event}[${index}]`;
        const expected: Omit<typeof context, "messages"> = {
          abortSignal: null,
          model: { id: "eve-mock/model" },
          session: {
            id: started.sessionId,
            auth: {
              current: expectedAuth(last ? "bob" : "alice"),
              initiator: expectedAuth("alice"),
            },
          },
          channel: {
            kind: "channel:skill-context",
            continuationToken: `skill-context:${threadId}`,
            metadata: { topic: "delegated-report", labels: ["context-contract"] },
          },
          conversation: {
            audience: "private",
            channel: { kind: "channel:skill-context", name: "skill-context" },
            mode: "conversation",
            environment: started.environment,
            principalType: "user",
          },
        };
        const { messages, ...actual } = context;
        for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
          t.check(actual[key], equals(expected[key])).label(`${label}: ctx.${key}`);
        }
        if (event === "session.started") {
          t.check(messages, equals([])).label(`${label}: ctx.messages precedes the first turn`);
          continue;
        }
        const userMessages = messages.filter((message) => message.role === "user");
        t.check(
          userMessages.some((message) => message.content === firstMessage),
          equals(true),
        ).label(`${label}: ctx.messages contains the original request`);
        t.check(
          userMessages.some((message) => message.content === followUp),
          equals(last),
        ).label(`${label}: ctx.messages includes the follow-up only after delivery`);
        if (last) {
          const replies = messages
            .filter((message) => message.role === "assistant")
            .map((message) =>
              typeof message.content === "string"
                ? message.content
                : message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join(""),
            );
          t.check(
            replies.some((reply) => reply.includes(childOutput)),
            equals(true),
          ).label(`${label}: ctx.messages retains the delivered child result`);
        }
      }
      t.notEvent("session.failed");
      t.noFailedActions();
      t.succeeded();
    },
  }),
);
