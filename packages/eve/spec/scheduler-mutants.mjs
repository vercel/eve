// Puts a bug into production's scheduler, one at a time, and checks that the scheduler checker
// (`src/execution/session/scheduler/checked.integration.test.ts`) finds it: a check that no
// mutant breaks would prove nothing. Each mutant edits a source file in place, runs the one
// case that reaches it, and restores the file, whatever happens.
//
//   pnpm spec:scheduler-mutants

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const session = join(root, "src/execution/session");

/** Each bug, as the change that brings it in, the case that reaches it, and what it finds. */
const MUTANTS = [
  {
    bug: "someone else's answers, split from their message, keep the delivery's id",
    file: "scheduler/answers.ts",
    from: "return `answers_${deliveryId}`;",
    to: "return deliveryId;",
    reaches: "people writing and answering",
  },
  {
    bug: "a cancel that arrives as the step settles the turn is never settled",
    file: "scheduler/turn.ts",
    from: "next.settlesCancel && turn.cancelledBy !== undefined",
    to: "false && turn.cancelledBy !== undefined",
    reaches: "controls",
  },
  {
    bug: "the session waits before its stream shows what it holds",
    file: "scheduler/waits.ts",
    from: "if (!ids.every((id) => session.view.deliveries[id] !== undefined))",
    to: "if (false)",
    reaches: "people writing and answering",
  },
  {
    bug: "someone else's message steers the turn",
    file: "scheduler/held.ts",
    from: "(delivery.auth === undefined || principalOf(delivery.auth) === turn.principal)",
    to: "true",
    reaches: "people writing and answering",
  },
  {
    bug: "a turn waiting on its person sleeps through their message",
    file: "scheduler/waits.ts",
    from: "return selection === undefined",
    to: "return true",
    reaches: "people writing and answering",
  },
  {
    bug: "a turn resumes once any of its sign-ins calls back",
    file: "scheduler/held.ts",
    from: "new Set(taken.map((entry) => entry.attemptId)).size < attemptIds.size",
    to: "false",
    reaches: "sign-ins",
  },
  {
    bug: "a turn waiting on its tasks sleeps once one settled",
    file: "scheduler/waits.ts",
    from: "taskWaitResult(session.tasks, wake) === undefined",
    to: "true",
    reaches: "tasks",
  },
  {
    bug: "the inbox's signal stops a turn for a cancel that names another",
    file: "arrivals.ts",
    from: "(arrival.turnId === undefined || arrival.turnId === turn.turnId)",
    to: "true",
    reaches: "controls",
  },
  {
    bug: "a cancel that names another turn stops this one",
    file: "scheduler/events.ts",
    from: "if (namesThisTurn && turn.cancelledBy === undefined)",
    to: "if (turn.cancelledBy === undefined)",
    reaches: "controls",
  },
  {
    bug: "a second cancel replaces the one the turn already took",
    file: "scheduler/events.ts",
    from: "if (namesThisTurn && turn.cancelledBy === undefined)",
    to: "if (namesThisTurn)",
    reaches: "controls",
  },
  {
    bug: "a held delivery never reaches the children it answers",
    file: "scheduler/next.ts",
    from: "if (!deciding) return undefined;",
    to: "if (true) return undefined;",
    reaches: "children",
  },
  {
    bug: "a turn admits nothing that arrives while it runs",
    file: "scheduler/events.ts",
    from: "admitted: [...turn.admitted, sequence]",
    to: "admitted: turn.admitted",
    reaches: "people writing and answering",
  },
];

let survived = 0;
for (const mutant of MUTANTS) {
  const path = join(session, mutant.file);
  const original = readFileSync(path, "utf8");
  if (!original.includes(mutant.from))
    throw new Error(`${mutant.file} no longer has: ${mutant.from}`);
  const started = performance.now();
  let run;
  try {
    writeFileSync(path, original.replace(mutant.from, mutant.to));
    run = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.integration.config.ts",
        "src/execution/session/scheduler/checked.integration.test.ts",
        "-t",
        mutant.reaches,
      ],
      { cwd: root, encoding: "utf8" },
    );
  } finally {
    writeFileSync(path, original);
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  const found = run.status !== 0 && /"finding":/.test(run.stdout + run.stderr);
  if (!found) survived += 1;
  const finding = /"finding": "([^"]*)"/.exec(run.stdout + run.stderr)?.[1];
  console.log(
    `${found ? "found" : "MISSED"}  ${mutant.bug} (${seconds}s)${finding === undefined ? "" : `\n        ${finding}`}`,
  );
}
if (survived > 0) {
  console.error(`${survived} of ${MUTANTS.length} mutants survived.`);
  process.exit(1);
}
console.log(`The checker found all ${MUTANTS.length} mutants.`);
