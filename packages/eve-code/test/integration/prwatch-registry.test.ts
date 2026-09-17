import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelPrwatchInState,
  completePrwatchInState,
  emptyPrwatchRegistry,
  isPrwatchCancelledInState,
  prwatchKey,
  registerPrwatchInState,
} from "../../extension/lib/prwatch-registry.ts";

const TARGET = { pullRequestNumber: 42, repo: "vercel/eve" };
const FIRST = { ...TARGET, callId: "call-1" };
const SECOND = { ...TARGET, callId: "call-2" };

test("keys a watch by canonical repo and pull request number", () => {
  assert.equal(prwatchKey(TARGET), "vercel/eve#42");
});

test("cancels only an active watch and ignores a second delete", () => {
  const registered = registerPrwatchInState(emptyPrwatchRegistry(), FIRST);
  assert.equal(isPrwatchCancelledInState(registered, FIRST), false);

  const cancelled = cancelPrwatchInState(registered, TARGET);
  assert.equal(cancelled.deleted, true);
  assert.equal(isPrwatchCancelledInState(cancelled.state, FIRST), true);

  const again = cancelPrwatchInState(cancelled.state, TARGET);
  assert.equal(again.deleted, false);
  assert.equal(isPrwatchCancelledInState(again.state, FIRST), true);
});

test("does not cancel a watch that was never started", () => {
  const result = cancelPrwatchInState(emptyPrwatchRegistry(), TARGET);
  assert.equal(result.deleted, false);
  assert.equal(isPrwatchCancelledInState(result.state, FIRST), true);
});

test("a duplicate start cannot replace an active owner", () => {
  const first = registerPrwatchInState(emptyPrwatchRegistry(), FIRST);
  const duplicate = registerPrwatchInState(first, SECOND);

  assert.equal(duplicate, first);
  assert.equal(isPrwatchCancelledInState(duplicate, FIRST), false);
  assert.equal(isPrwatchCancelledInState(duplicate, SECOND), true);
});

test("delete followed by restart leaves the replacement active", () => {
  const first = registerPrwatchInState(emptyPrwatchRegistry(), FIRST);
  const deleted = cancelPrwatchInState(first, TARGET);
  const restarted = registerPrwatchInState(deleted.state, SECOND);

  assert.equal(deleted.deleted, true);
  assert.equal(isPrwatchCancelledInState(restarted, FIRST), true);
  assert.equal(isPrwatchCancelledInState(restarted, SECOND), false);
});

test("only the owning call can complete a watch", () => {
  const first = registerPrwatchInState(emptyPrwatchRegistry(), FIRST);
  const duplicate = registerPrwatchInState(first, SECOND);
  const staleCompletion = completePrwatchInState(duplicate, SECOND);

  assert.equal(staleCompletion, first);
  assert.equal(isPrwatchCancelledInState(staleCompletion, FIRST), false);

  const completed = completePrwatchInState(staleCompletion, FIRST);
  assert.equal(isPrwatchCancelledInState(completed, FIRST), true);
  assert.equal(cancelPrwatchInState(completed, TARGET).deleted, false);
});
