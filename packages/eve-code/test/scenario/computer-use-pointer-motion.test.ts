import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { POINTER_MOTION_MJS_SOURCE } from "../../extension/lib/computer-use-driver-source.ts";

type Point = { x: number; y: number };
type PlannedPoint = Point & { delayMs: number };
type PointerPlan = { phases: PlannedPoint[][]; settleMs: number };

async function pointerMotionPlan(
  start: Point,
  end: Point,
  options: { style: "natural" | "precision" },
): Promise<PointerPlan> {
  const directory = await mkdtemp(join(tmpdir(), "computer-use-pointer-"));
  const path = join(directory, "pointer-motion.mjs");
  try {
    await writeFile(path, POINTER_MOTION_MJS_SOURCE);
    const module = (await import(`${pathToFileURL(path).href}?${Date.now()}`)) as {
      pointerMotionPlan(start: Point, end: Point, options: { style: string }): PointerPlan;
    };
    return module.pointerMotionPlan(start, end, options);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

const start = { x: 100, y: 100 };
const end = { x: 900, y: 500 };

test("natural pointer motion is deterministic, curved, and exact", async () => {
  const first = await pointerMotionPlan(start, end, { style: "natural" });
  const second = await pointerMotionPlan(start, end, { style: "natural" });
  assert.deepEqual(first, second);
  assert.equal(first.phases.length, 1);
  assert.deepEqual(first.phases[0]?.at(-1), { ...end, delayMs: 0 });
  assert.ok(
    first.phases[0]?.some(
      (point) =>
        point.y !==
        Math.round(start.y + (end.y - start.y) * ((point.x - start.x) / (end.x - start.x))),
    ),
  );
  assert.ok(first.settleMs >= 15 && first.settleMs <= 30);
});

test("precision pointer motion undershoots once then corrects exactly", async () => {
  const plan = await pointerMotionPlan(start, end, { style: "precision" });
  assert.equal(plan.phases.length, 2);
  const undershoot = plan.phases[0]?.at(-1);
  assert.ok(undershoot !== undefined && undershoot.x > start.x && undershoot.x < end.x);
  assert.deepEqual(plan.phases[1]?.at(-1), { ...end, delayMs: 0 });
  assert.equal(plan.settleMs, 0);
  const duration = (phase: PlannedPoint[]) =>
    phase.reduce((total, point) => total + point.delayMs, 0);
  assert.ok(duration(plan.phases[1] ?? []) > duration(plan.phases[0] ?? []) / 2);
});

test("natural pointer defaults stay brisk across distances", async () => {
  const short = await pointerMotionPlan(start, { x: 250, y: 100 }, { style: "natural" });
  const long = await pointerMotionPlan(start, { x: 1_800, y: 900 }, { style: "natural" });
  const duration = (plan: PointerPlan) =>
    plan.phases.flat().reduce((total, point) => total + point.delayMs, 0);
  assert.ok(duration(short) < 200);
  assert.ok(duration(long) < 550);
});

test("short precision moves avoid theatrical corrections", async () => {
  const plan = await pointerMotionPlan(start, { x: 150, y: 120 }, { style: "precision" });
  assert.equal(plan.phases.length, 1);
  assert.deepEqual(plan.phases[0]?.at(-1), { x: 150, y: 120, delayMs: 0 });
});
