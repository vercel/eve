import { equals } from "eve/evals/expect";
import { CROSS_TURN_SCENARIO } from "../agent/lib/lifecycle-model.js";
import { completedTaskIds } from "./batching.js";
import { lifecycleDriver } from "./lifecycle.js";
import { defineTaskEval } from "./task-transition.js";

export default (["A", "B"] as const).map((first) =>
  defineTaskEval({
    description: `Keep overlapping requests independent; ${first} completes while the other task is still gated.`,
    timeoutMs: 180_000,
    transition: {
      primary: "task.parent.wake.emitted-ready",
      setup: ["task.lifecycle.complete.accepted-nonterminal"],
      dimensions: { transport: "local", parentPhase: "parked" },
    },
    async test(t) {
      const key = crypto.randomUUID();
      const driver = lifecycleDriver(t, key);
      const started = await driver.start(`${CROSS_TURN_SCENARIO} ${key}`);
      started.messageIncludes("LAUNCHED:A");
      const a = await driver.gate("A");
      await t.require([...driver.taskIds.keys()], equals(["A"]));
      await driver.active(a);

      const launchB = "Alice now launches the second piece of work.";
      await driver.enqueue(launchB);
      const second = await driver.through(launchB);
      second.messageIncludes("LAUNCHED:B");
      const b = await driver.gate("B");
      await driver.active(a);
      await driver.active(b);
      await t.require([...driver.taskIds.keys()].sort(), equals(["A", "B"]));
      await t.require(new Set(driver.taskIds.values()).size, equals(2));
      const owners = driver.controls.filter((event) => event.kind === "owner");
      await t.require(
        owners.map((event) => event.marker),
        equals(["A", "B"]),
      );
      await t.require(new Set(owners.map((event) => event.turnId)).size, equals(2));
      const creatingTurns = [started, second].map(
        (turn) => turn.events.find((event) => event.type === "actions.requested")?.data.turnId,
      );
      await t.require(
        owners.map((event) => event.turnId),
        equals(creatingTurns),
      );

      const remaining = first === "A" ? "B" : "A";
      await driver.release(first === "A" ? a : b);
      await driver.settled(first);
      const firstReport = await driver.report();
      await t.require(completedTaskIds(firstReport), equals([driver.taskIds.get(first)]));
      await driver.active(remaining === "A" ? a : b);
      const checkpoint = "Alice checks that the other piece of work is still pending.";
      await driver.enqueue(checkpoint);
      const pending = await driver.through(checkpoint);
      pending.messageIncludes("PENDING-CHECK-ACK");
      t.check(driver.turns.flatMap(completedTaskIds), equals([driver.taskIds.get(first)])).label(
        `${first} reports independently while ${remaining} remains pending`,
      );

      await driver.release(remaining === "A" ? a : b);
      await driver.settled(remaining);
      const lastReport = await driver.report();
      const drain = "Alice confirms that all completion deliveries have been observed.";
      await driver.enqueue(drain);
      (await driver.through(drain, true)).messageIncludes("DRAIN-ACK");
      await t.require(completedTaskIds(lastReport), equals([driver.taskIds.get(remaining)]));
      const requestIds = new Map([
        ["A", creatingTurns[0]],
        ["B", creatingTurns[1]],
      ]);
      for (const [marker, report] of [
        [first, firstReport],
        [remaining, lastReport],
      ] as const) {
        const terminal = report.events.find((event) => event.type === "turn.completed");
        t.check(
          terminal?.meta.request,
          equals({ id: requestIds.get(marker), phase: "settled", outcome: "completed" }),
        );
      }
      for (const launch of [started, second]) {
        t.check(
          launch.events.filter((event) => event.meta.request?.outcome !== undefined).length,
          equals(0),
        );
      }
      t.check(
        driver.turns.flatMap(completedTaskIds).sort(),
        equals([...driver.taskIds.values()].sort()),
      );
      t.noFailedActions();
      t.notEvent("compaction.requested");
    },
  }),
);
