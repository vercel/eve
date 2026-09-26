import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Cancelling an agent task cancels the agent's current turn; continuing it by taskId reaches the same conversation.",
  timeoutMs: 120_000,

  async test(t) {
    const turn = await t.send(
      [
        "Alice is checking that a paused helper keeps its notes. AGENT-TASK-CANCEL",
        'Ask the sleeper agent with the message "Please wait for cancellation."',
        "Once it is waiting, stop that sleeper task with task_cancel.",
        'Then continue the same sleeper task with its taskId and the message "SLEEPER-FOLLOW-UP", and report its reply.',
      ].join("\n"),
    );
    turn.expectOk();

    const started = turn.events.find((event) => event.type === "agent.started");
    if (started?.type !== "agent.started") throw new Error("The sleeper agent never started.");
    const cancelledTurn = await t.target.watchTurn(started.data.sessionId).result();
    cancelledTurn.event("turn.cancelled", { count: 1 });

    t.event("agent.started", { count: 1, data: { name: "sleeper" } });
    t.event("task.settled", { count: 1, data: { status: "cancelled" } });
    // The continued sleeper's own reply, not the parent's retelling of it.
    t.event("task.settled", {
      count: 1,
      data: { output: /SLEEPER-REMEMBERS=true/u, status: "completed" },
    });
    t.notEvent("turn.failed");
  },
});
