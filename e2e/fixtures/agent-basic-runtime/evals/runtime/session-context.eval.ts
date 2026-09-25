import { defineEval, type EveEvalTurn } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "Creation context reaches dynamic instructions and tools across turns, including prewarming.",
  async test(t) {
    const sessionContext = { surface: "docs", preferences: { compact: true } };
    const message = "Alice opened the docs chat. Read its session context.";
    for (const prewarm of [false, true]) {
      let first: EveEvalTurn;
      if (prewarm) {
        first = await (await t.session({ sessionContext })).send(message);
      } else {
        const created = await t.target.fetch("/eve/v1/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionContext, message }),
        });
        await t.require(created.status, equals(202));
        const { sessionId } = (await created.json()) as { sessionId: string };
        first = await t.target.watchTurn(sessionId).result();
      }
      const sessionId = first.sessionId;
      first.expectOk();
      first.event("session.started", { count: 1 });
      first.calledTool("read_session_context");
      first.messageIncludes(JSON.stringify(sessionContext));

      const replacement = await t.target.fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Alice continues the chat.",
          sessionContext: { surface: "support" },
        }),
      });
      await t.require(replacement.status, equals(400));

      const second = await first.session.send(
        "Alice is continuing the same chat. Read its session context again.",
      );
      second.expectOk();
      second.calledTool("read_session_context");
      second.messageIncludes(JSON.stringify(sessionContext));
    }
  },
});
