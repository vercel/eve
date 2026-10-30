import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Cancelling an agent task ends it; a fresh task starts with a separate conversation.",
  timeoutMs: 120_000,

  async test(t) {
    const turn = await t.send(
      [
        "Alice is stopping a paused helper before starting a separate review. AGENT-TASK-CANCEL",
        'Ask the sleeper agent with the message "Please wait for cancellation."',
        "Once it is waiting, stop that sleeper task with eve__task_cancel.",
        'Then start a new sleeper task without a taskId, with the message "SLEEPER-FOLLOW-UP", and report its reply.',
      ].join("\n"),
    );
    turn.expectOk();

    const started = turn.events.find((event) => event.type === "child.opened");
    if (started?.type !== "child.opened") throw new Error("The sleeper agent never started.");
    const cancelledTurn = await t.target.attach(started.data.sessionId).watch().result();
    cancelledTurn.event("turn.settled", { count: 1, data: { outcome: "cancelled" } });

    t.event("child.opened", { count: 2, data: { name: "sleeper" } });
    t.eventsSatisfy("the restarted sleeper has its own task and session", (events) => {
      const tasks = events.flatMap((event) =>
        event.type === "task.started" && event.data.name === "sleeper" ? [event.data.taskId] : [],
      );
      const children = events.flatMap((event) =>
        event.type === "child.opened" && event.data.name === "sleeper"
          ? [event.data.sessionId]
          : [],
      );
      return tasks.length === 2 && new Set(tasks).size === 2 && new Set(children).size === 2;
    });
    t.event("task.ended", { count: 1, data: { outcome: "cancelled" } });
    t.event("call.settled", {
      count: 1,
      data: { outcome: "interrupted" },
      scope: { taskId: /./u },
    });
    // The fresh sleeper's own reply verifies that cancelled history did not carry over.
    t.event("call.settled", {
      count: 1,
      data: { output: /SLEEPER-REMEMBERS=false/u, outcome: "completed" },
    });
    t.notEvent("turn.settled", { data: { outcome: "failed" } });
  },
});
