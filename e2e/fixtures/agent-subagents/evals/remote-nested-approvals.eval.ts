import { defineEval } from "eve/evals";
import { NESTED_APPROVALS } from "../agent/lib/remote-nested-script.js";

export default defineEval({
  description: "Alice approves two nested workers of a remote agent, each at two successive gates.",
  timeoutMs: 120_000,
  async test(t) {
    const started = await t.send(
      `${NESTED_APPROVALS}: Alice asks the remote agent to collect both release checklist approvals.`,
    );
    started.expectOk();
    let session = started.session;
    const seen = new Map<string, Set<string>>([
      ["first_gate", new Set()],
      ["second_gate", new Set()],
    ]);
    for (let attempt = 0; attempt < 16; attempt++) {
      const pending = session.pendingInteractions.filter(
        (request) => !seen.get(request.call!.name)?.has(request.interactionId),
      );
      if (pending.length > 0) {
        for (const request of pending) {
          const ids = seen.get(request.call!.name);
          if (ids === undefined || ids.size >= 2 || request.request.kind !== "approval") {
            throw new Error(`Unexpected nested approval for ${request.call!.name}.`);
          }
          ids.add(request.interactionId);
        }
        const answered = await session.respond(
          pending.map((request) => ({ interactionId: request.interactionId, optionId: "approve" })),
        );
        answered.expectOk();
        if (answered.reply?.includes("PARENT-NESTED-COMPLETE: CHILD-NESTED-APPROVALS-COMPLETE")) {
          if ([...seen.values()].some((ids) => ids.size !== 2))
            throw new Error("Both workers did not pass both gates.");
          t.noFailedCalls();
          return;
        }
        session = answered.session;
        continue;
      }
      const live = t.target.attach(session.id!, { startIndex: session.state!.streamIndex }).watch();
      const turn = await live.result();
      turn.noFailedCalls();
      if (turn.reply?.includes("PARENT-NESTED-COMPLETE: CHILD-NESTED-APPROVALS-COMPLETE")) {
        if ([...seen.values()].some((ids) => ids.size !== 2))
          throw new Error("Both workers did not pass both gates.");
        t.noFailedCalls();
        return;
      }
      session = live.session;
    }
    throw new Error(
      `Nested approvals did not settle: ${[...seen].map(([gate, ids]) => `${gate}=${ids.size}`).join(", ")}.`,
    );
  },
});
