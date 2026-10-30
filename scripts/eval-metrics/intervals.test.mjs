import test from "node:test";
import assert from "node:assert/strict";
import { coveredLengthBetween, pairIntervals, unionIntervals } from "./measurements/intervals.mjs";

const event = (type, id, second, data = {}) => ({
  type,
  meta: { id, at: `2026-01-01T00:00:${String(second).padStart(2, "0")}Z` },
  data,
});
const actionKeys = {
  startKeys: (e) => e.data.actions?.map((action) => action.callId),
  endKeys: (e) => [e.data.result?.callId],
  subject: "action",
};
const requested = (id, second, ...callIds) =>
  event("actions.requested", id, second, { actions: callIds.map((callId) => ({ callId })) });
const result = (id, second, callId) => event("action.result", id, second, { result: { callId } });

test("pairs batched starts with out-of-order ends by key", () => {
  const paired = pairIntervals(
    [requested("batch", 1, "a", "b")],
    [result("b-end", 5, "b"), result("a-end", 3, "a")],
    actionKeys,
  );
  assert.equal(paired.status, "ready");
  assert.deepEqual(
    paired.intervals.map(({ key, startAt, endAt }) => [key, endAt - startAt]),
    [
      ["a", 2000],
      ["b", 4000],
    ],
  );
});

test("partial, ambiguous, and malformed pairings are unavailable", () => {
  for (const [starts, ends, reason] of [
    [[requested("r", 1, "a")], [], "action-incomplete"],
    [[], [result("e", 2, "a")], "action-start-missing"],
    [[requested("r", 1, "a"), requested("again", 2, "a")], [], "ambiguous-action"],
    [[requested("r", 1, "a")], [result("e1", 2, "a"), result("e2", 3, "a")], "ambiguous-action"],
    [[requested("r", 1)], [], "missing-action-identity"],
    [[requested("r", 3, "a")], [result("e", 1, "a")], "negative-duration"],
    [[requested("r", "xx", "a")], [result("e", 1, "a")], "missing-timestamp"],
  ])
    assert.deepEqual(pairIntervals(starts, ends, actionKeys), { status: "unavailable", reason });
});

test("repeated starts can resolve to the earliest announcement", () => {
  const keys = { ...actionKeys, repeatedStarts: "earliest" };
  const paired = pairIntervals(
    [requested("late", 4, "a"), requested("early", 2, "a")],
    [result("e", 6, "a")],
    keys,
  );
  assert.equal(paired.intervals[0].start.meta.id, "early");
});

test("unions overlapping intervals and measures coverage within and outside bounds", () => {
  const spans = [
    { startAt: 0, endAt: 4 },
    { startAt: 2, endAt: 6 },
    { startAt: 6, endAt: 7 },
    { startAt: 10, endAt: 12 },
  ];
  assert.deepEqual(unionIntervals(spans), [
    { startAt: 0, endAt: 7 },
    { startAt: 10, endAt: 12 },
  ]);
  assert.equal(coveredLengthBetween(spans), 9);
  assert.equal(coveredLengthBetween(spans, { within: [{ startAt: 3, endAt: 11 }] }), 5);
  assert.equal(
    coveredLengthBetween(spans, {
      within: [{ startAt: 3, endAt: 11 }],
      excluding: [{ startAt: 5, endAt: 10.5 }],
    }),
    2.5,
  );
  assert.equal(coveredLengthBetween([]), 0);
});
