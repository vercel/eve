import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  abstraction,
  advance,
  checkTakingAnswers,
  coverage,
  exploredId,
  checkWaiting,
  choices,
  drain,
  fingerprint,
  initialWorld,
  quiet,
  type Bounds,
  type Finding,
  type World,
} from "#internal/testing/session-explorer.js";

// The harness runs outside a workflow body here, where run attributes cannot be written.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));
// Ids the AI SDK mints come from the path, so each path mints the same ones every time.
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateId: () => exploredId(),
}));
vi.setConfig({ testTimeout: 300_000 });

const DEPTH = Number(process.env.EVE_EXPLORE_DEPTH ?? 4);
const BOUNDS: Bounds = {
  deliveries: Number(process.env.EVE_EXPLORE_DELIVERIES ?? 3),
  duringStep: process.env.EVE_EXPLORE_DURING_STEP === "1",
  controls: process.env.EVE_EXPLORE_CONTROLS === "1",
};

/** Every path from the session's start, `depth` choices deep. */
async function explore(depth: number, bounds: Bounds) {
  const findings: Finding[] = [];
  // The most moves left any path reached each state with: a path that reaches it with more
  // explores it again, so every path up to the bound runs.
  const seen = new Map<string, number>();
  let steps = 0;
  let leaves = 0;
  let taken = 0;
  const visit = async (world: World, left: number): Promise<void> => {
    const key = fingerprint(world);
    const reached = seen.get(key);
    if (reached !== undefined && reached >= left) return;
    if (reached === undefined) {
      checkWaiting(world, findings);
      taken += await checkTakingAnswers(world, findings);
    }
    seen.set(key, left);
    const options = choices(world, bounds);
    if (left === 0 || options.length === 0) {
      leaves += 1;
      await drain(world, findings);
      return;
    }
    let modelUnused = false;
    for (const choice of options) {
      // A step that never called the model is the same whatever the model would have done.
      if (
        choice.kind === "model" &&
        choice.move !== "reply" &&
        modelUnused &&
        choice.during === undefined
      )
        continue;
      steps += 1;
      const next = await advance(world, choice, findings);
      if (choice.kind === "model" && choice.move === "reply" && choice.during === undefined)
        modelUnused = next.calledModel === false;
      await visit(next, left - 1);
    }
  };
  await visit(initialWorld(), depth);
  // Every state the bound reaches, in one digest: a change that keeps it changed nothing any path
  // up to the bound can see.
  if (process.env.EVE_EXPLORE_DUMP !== undefined)
    writeFileSync(process.env.EVE_EXPLORE_DUMP, [...seen.keys()].sort().join("\n"));
  const digest = createHash("sha256")
    .update([...seen.keys()].sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
  return { digest, findings, leaves, states: seen.size, steps, taken };
}

describe("sessions explored to a bound keep their promises on every path", () => {
  it(`explores ${DEPTH} moves deep`, async () => {
    vi.useFakeTimers({ now: new Date("2030-01-01T00:00:00.000Z"), toFake: ["Date"] });
    const started = performance.now();
    const result = await explore(DEPTH, BOUNDS);
    vi.useRealTimers();
    const unique = new Map<string, Finding>();
    for (const finding of result.findings)
      if (!unique.has(finding.finding)) unique.set(finding.finding, finding);
    process.stdout.write(
      `explored ${result.states} states (${result.digest}), ${result.steps} moves, ${result.leaves} leaves, ${result.taken} deliveries checked through answer intake, in ${Math.round(performance.now() - started)}ms\n`,
    );
    if (process.env.EVE_EXPLORE_COVERAGE === "1")
      process.stdout.write(
        `${[...coverage]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, count]) => `${key} ${count}`)
          .join("\n")}\n`,
      );
    expect(
      [...unique.values()].map(
        (finding) => `${finding.finding} (after ${finding.trail.join(" → ")})`,
      ),
    ).toEqual([]);
  });
});

/**
 * Every abstract state the session can reach, to a fixpoint: each is expanded once, with every
 * choice, until no choice reaches a new one. A second session with the same abstraction is
 * expanded too, once, and must reach the same abstractions, or the abstraction merged states
 * that behave differently. Then every state must reach a quiet one, with nothing open or held.
 */
async function close(bounds: Bounds, limit: number) {
  const findings: Finding[] = [];
  const known = new Map<string, { world: World; successors?: readonly string[]; checked?: true }>();
  const frontier: World[] = [];
  const expand = async (world: World) => {
    checkWaiting(world, findings);
    await checkTakingAnswers(world, findings);
    const successors: string[] = [];
    let modelUnused = false;
    for (const choice of choices(world, bounds)) {
      if (
        choice.kind === "model" &&
        choice.move !== "reply" &&
        modelUnused &&
        choice.during === undefined
      )
        continue;
      const next = await advance(world, choice, findings);
      if (choice.kind === "model" && choice.move === "reply" && choice.during === undefined)
        modelUnused = next.calledModel === false;
      const key = abstraction(next, bounds);
      successors.push(key);
      const entry = known.get(key);
      if (entry === undefined) {
        known.set(key, { world: next });
        frontier.push(next);
      } else if (
        entry.checked === undefined &&
        entry.successors !== undefined &&
        next.trail.length > entry.world.trail.length
      ) {
        entry.checked = true;
        const again = await expandOnly(next);
        if (JSON.stringify(again) !== JSON.stringify(entry.successors))
          findings.push({
            finding: `two sessions with one abstraction behave differently (first reached by ${entry.world.trail.join(" → ")})`,
            trail: next.trail,
          });
      }
    }
    return [...new Set(successors)].sort();
  };
  const expandOnly = async (world: World) => {
    const successors: string[] = [];
    let modelUnused = false;
    for (const choice of choices(world, bounds)) {
      if (
        choice.kind === "model" &&
        choice.move !== "reply" &&
        modelUnused &&
        choice.during === undefined
      )
        continue;
      const next = await advance(world, choice, []);
      if (choice.kind === "model" && choice.move === "reply" && choice.during === undefined)
        modelUnused = next.calledModel === false;
      successors.push(abstraction(next, bounds));
    }
    return [...new Set(successors)].sort();
  };
  const start = initialWorld();
  known.set(abstraction(start, bounds), { world: start });
  frontier.push(start);
  while (frontier.length > 0 && known.size < limit) {
    const world = frontier.shift()!;
    known.get(abstraction(world, bounds))!.successors = await expand(world);
  }
  const closed = frontier.length === 0;
  if (process.env.EVE_EXPLORE_DUMP !== undefined)
    writeFileSync(process.env.EVE_EXPLORE_DUMP, [...known.keys()].join("\n"));
  // Every state reaches a quiet one: search back from the quiet states over every edge.
  const reaches = new Set([...known].filter(([, entry]) => quiet(entry.world)).map(([key]) => key));
  for (let grew = true; grew;) {
    grew = false;
    for (const [key, entry] of known)
      if (!reaches.has(key) && entry.successors?.some((next) => reaches.has(next))) {
        reaches.add(key);
        grew = true;
      }
  }
  if (closed)
    for (const [key, entry] of known)
      if (!reaches.has(key))
        findings.push({ finding: "a state that can never become quiet", trail: entry.world.trail });
  return {
    closed,
    findings,
    quiet: [...known.values()].filter((entry) => quiet(entry.world)).length,
    states: known.size,
  };
}

describe("the abstract states a session reaches close, keep their promises, and all become quiet", () => {
  it("closes", async () => {
    vi.useFakeTimers({ now: new Date("2030-01-01T00:00:00.000Z"), toFake: ["Date"] });
    const started = performance.now();
    const result = await close(
      {
        controls: process.env.EVE_EXPLORE_CONTROLS === "1",
        deliveries: Number.POSITIVE_INFINITY,
        duringStep: process.env.EVE_EXPLORE_DURING_STEP === "1",
        held: Number(process.env.EVE_EXPLORE_HELD ?? 1),
        turnArrivals: Number(process.env.EVE_EXPLORE_TURN_ARRIVALS ?? 2),
      },
      Number(process.env.EVE_EXPLORE_LIMIT ?? 20_000),
    );
    vi.useRealTimers();
    process.stdout.write(
      `${result.closed ? "closed" : "did not close"} at ${result.states} abstract states (${result.quiet} quiet) in ${Math.round(performance.now() - started)}ms\n`,
    );
    const unique = new Map<string, Finding>();
    for (const finding of result.findings)
      if (!unique.has(finding.finding)) unique.set(finding.finding, finding);
    expect(
      [...unique.values()].map(
        (finding) => `${finding.finding} (after ${finding.trail.join(" → ")})`,
      ),
    ).toEqual([]);
    expect(result.closed).toBe(true);
  });
});
