import { defineEval } from "eve/evals";
import {
  agentEvalTags,
  assertPlainTextDelivery,
  requireDeliveredText,
} from "@evals/agent/shared";

export default defineEval({
  description: "Delegates browser work and cancels it through task steering",
  tags: [...agentEvalTags, "browser-agent", "orchestration"],
  async test(t) {
    const session = await t.session();
    const live = await session.start(
      "Use the browser-agent subagent to visually inspect https://example.com and report the exact primary heading. Do not use web_fetch because this specifically requires browser interaction."
    );
    await live.waitForToolCall("run_browser");
    await live.waitForEvent("task.started", { data: { name: "run_browser" } });

    // The turn holds while the browser task works, so the request steers it.
    const cancelled = await session.send("Cancel that browser task now.", {
      turnPolicy: "steer",
    });
    const delegated = await live.result();
    delegated.expectOk();
    cancelled.expectOk();
    cancelled.succeeded();
    t.calledTool("run_browser", { count: 1 });
    t.calledTool("eve__task_cancel", { status: "completed", count: 1 });
    const confirmation = await requireDeliveredText(t, cancelled);
    assertPlainTextDelivery(t, confirmation);
  },
});
