import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionOwner } from "../lib/session-store.ts";

test("store ownership is stable across sign-ins without rewriting the authenticated user", () => {
  const user = Object.freeze({
    id: "login-1",
    vercelSubject: "vercel-alice",
    name: "Alice",
    email: "old@example.com",
  });
  const first = sessionOwner(user)!;
  const nextUser = { ...user, id: "login-2", name: "Alice Updated", email: "new@example.com" };
  const second = sessionOwner(nextUser)!;
  assert.equal(first.key, second.key);
  assert.equal(user.id, "login-1");
  assert.deepEqual(Object.keys(first).sort(), ["key", "name"]);
  assert.notEqual(first.key, sessionOwner({ ...user, vercelSubject: "vercel-bob" })!.key);
});
test("an anonymous user has no owner and an old signed-in cookie fails closed", () => {
  assert.equal(sessionOwner(null), null);
  assert.throws(() => sessionOwner({ name: "Alice", email: "alice@example.com" }), /Sign in again/);
});
