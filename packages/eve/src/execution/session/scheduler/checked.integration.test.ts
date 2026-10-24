import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { explore, type Bounds, type Feature } from "#internal/testing/scheduler-checker.js";

// The scheduler alone, explored to a bound, with what holds checked in every state it reaches
// (`internal/testing/scheduler-checker.ts`). Each case adds one part of the world to a core of
// Alice and Bob writing and answering while turns ask, call, and wait; `EVE_CHECK_SCHEDULER_WIDEN`
// raises every bound by that much. `EVE_CHECK_SCHEDULER_OBSERVE=<prefix>` writes what the world
// observes in each case to `<prefix>.<case>`, for `pnpm spec:scheduler-compare` against another
// version of the scheduler.

const WIDEN = Number(process.env.EVE_CHECK_SCHEDULER_WIDEN ?? 0);
const OBSERVE = process.env.EVE_CHECK_SCHEDULER_OBSERVE;

const CORE: Bounds = {
  asks: 2 + WIDEN,
  calls: 1 + WIDEN,
  duringStep: true,
  features: [],
  sends: 3 + WIDEN,
  steps: 4 + WIDEN,
  tasks: 0,
};

const CASES: readonly { readonly name: string; readonly bounds: Bounds }[] = [
  { bounds: CORE, name: "people writing and answering, and calls" },
  { bounds: { ...CORE, features: ["controls"] }, name: "controls" },
  { bounds: { ...CORE, features: ["sign-ins"] }, name: "sign-ins" },
  { bounds: { ...CORE, calls: 2 + WIDEN, features: ["tasks"], tasks: 1 + WIDEN }, name: "tasks" },
  { bounds: { ...CORE, features: ["children"] }, name: "children" },
  {
    bounds: { ...CORE, features: ["delegated", "queue"] },
    name: "delegated callers and queued messages",
  },
  { bounds: { ...CORE, features: ["budget", "controls"], sends: 2 + WIDEN }, name: "budgets" },
  { bounds: { ...CORE, features: ["handoff", "ends"] }, name: "hand-offs and the session ending" },
  { bounds: { ...CORE, features: ["policies"] }, name: "answers a response policy weighs" },
];

describe("the scheduler, checked to a bound", () => {
  it.each(CASES)("keeps every promise with $name", ({ bounds }) => {
    const started = performance.now();
    const explored = explore(bounds, { observe: OBSERVE !== undefined });
    if (explored.observed !== undefined)
      writeFileSync(
        `${OBSERVE}.${features(bounds.features)}`,
        [...explored.observed].map(([seen, trail]) => `${seen}\t${trail}\n`).join(""),
      );
    const coverage = [...explored.coverage].map(([kind, count]) => `${kind} ${count}`).join(", ");
    process.stderr.write(
      `${features(bounds.features)}: ${explored.states} states, ${explored.edges} edges, ${explored.quiet} quiet, in ${Math.round(performance.now() - started)}ms (${coverage})\n`,
    );
    expect(explored.findings.slice(0, 5)).toEqual([]);
  });
});

function features(list: readonly Feature[]): string {
  return list.length === 0 ? "core" : list.join("+");
}
