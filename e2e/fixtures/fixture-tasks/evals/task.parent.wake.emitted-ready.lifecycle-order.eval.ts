import { equals } from "eve/evals/expect";
import { LIFECYCLE_SCENARIO } from "../agent/lib/lifecycle-model.js";
import { completedTaskIds } from "./batching.js";
import { assertLifecycleUnion, lifecycleDriver } from "./lifecycle.js";
import { defineTaskEval } from "./task-transition.js";

export default defineTaskEval({
  description:
    "Process A completion, B terminal agent settlement, and B completion in FIFO order after an active parent turn.",
  timeoutMs: 180_000,
  transition: {
    primary: "task.parent.wake.emitted-ready",
    setup: ["task.lifecycle.complete.accepted-nonterminal", "task.parent.wake.noop-pending-cohort"],
    dimensions: { transport: "local", parentPhase: "active" },
  },
  async test(t) {
    const key = crypto.randomUUID();
    const driver = lifecycleDriver(t, key);
    const started = await driver.start(`${LIFECYCLE_SCENARIO} ${key}`);
    started.messageIncludes("LAUNCHED:A,B");
    const a = await driver.gate("A");
    const b = await driver.gate("B");
    await t.require([...driver.taskIds.keys()].sort(), equals(["A", "B"]));
    await t.require(new Set(driver.taskIds.values()).size, equals(2));
    const owners = driver.controls.filter((event) => event.kind === "owner");
    await t.require(owners.map((event) => event.marker).sort(), equals(["A", "B"]));
    await t.require(new Set(owners.map((event) => event.turnId)).size, equals(1));

    const holding = "Alice keeps the parent active while Bob finishes.";
    await driver.enqueue(holding);
    const parent = await driver.gate("parent");
    await driver.active(parent);

    await driver.release(a);
    // Owner completion includes the awaited wakeTaskParentStep, unlike child stream completion.
    await driver.settled("A");
    await driver.active(parent);
    await driver.release(b);
    // This owner had exactly one agent invocation. Its second agent-request
    // forwarding step is settlement, and must precede its successful task wake.
    await driver.settled("B", true);
    const child = await t.target.watchTurn(b.sessionId, { startIndex: 0 }).result();
    child.event("session.failed");
    t.check(
      child.events.flatMap((event) =>
        event.type === "step.completed"
          ? [
              {
                inputTokens: event.data.usage?.inputTokens,
                outputTokens: event.data.usage?.outputTokens,
              },
            ]
          : [],
      ),
      equals([{ inputTokens: 211, outputTokens: 37 }]),
    ).label("B performed real metered work before its terminal provider rejection");
    await driver.active(parent);
    // Owner completion proves enqueue, not driver receipt. A normal cancellation
    // behind B's wake must traverse the same FIFO inbox before ending this turn.
    // Releasing the unrelated fixture hook here would let turn-result win early.
    await driver.cancelHeldTurn(parent);
    const cancelled = await driver.through(holding);
    await t.require(
      cancelled.events.flatMap((event) =>
        event.type === "turn.cancelled" ? [event.data.turnId] : [],
      ),
      equals([parent.turnId]),
    );
    cancelled.event("session.waiting");
    cancelled.notEvent("turn.completed");
    await t.require(completedTaskIds(cancelled), equals([]));
    await driver.parentGateCancelled(parent);
    t.log(
      "FIFO cancellation acknowledged: A completed -> B agent-settled -> B completed were buffered before the held turn ended; its fixture hook was disposed.",
    );
    await driver.report();

    const drain = "Alice confirms that all completion deliveries have been observed.";
    await driver.enqueue(drain);
    (await driver.through(drain, true)).messageIncludes("DRAIN-ACK");
    assertLifecycleUnion(t, driver);
    // This is the actual framework handle announcement in the model request,
    // not a status inferred from the successful background-task report.
    const handlesMessage = "Alice checks that Bob's terminal session has no retained handle.";
    await driver.enqueue(handlesMessage);
    const handles = await driver.through(handlesMessage);
    t.check(JSON.parse(handles.message!), equals([])).label(
      "B's terminal child has no retained available or parked handle",
    );
    handles.usedNoTools();

    await driver.enqueue("Alice performs the final metered accounting check.");
    (await driver.through("Alice performs the final metered accounting check.")).messageIncludes(
      "ACCOUNTING-CHECK",
    );
    await driver.enqueue("Alice checks the remaining session budget.");
    const budget = await driver.nextTurn();
    await t.require(budget.inputRequests.length, equals(1));
    const request = budget.inputRequests[0]!;
    t.check(
      { kind: request.kind, tool: request.action.toolName, input: request.action.input },
      equals({
        kind: "session-limit",
        tool: "session_limit_continuation",
        input: { kind: "input", limit: 1_000_000, usedTokens: 1_000_001 },
      }),
    ).label(
      "runtime session total includes exactly B's 211 input tokens plus 999790 parent tokens",
    );
    budget.notEvent("step.started");
    budget.usedNoTools();
    t.notEvent("compaction.requested");
    // No blanket noFailedActions: Bob's provider rejection is intentional.
  },
});
