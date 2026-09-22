import assert from "node:assert/strict";
import { test } from "node:test";
import { viewerFromVerifiedSession } from "../lib/session-identity.ts";

test("history ownership survives new sign-ins and profile changes", () => {
  const first = viewerFromVerifiedSession({
    user: {
      vercelSubject: "vercel-alice",
      name: "Alice",
      email: "old@example.com",
      image: "https://example.com/alice.png",
    },
  })!;
  const second = viewerFromVerifiedSession({
    user: { vercelSubject: "vercel-alice", name: "Alice Updated", email: "new@example.com" },
  })!;
  assert.equal(first.key, second.key);
  assert.equal(first.principal.principalId, "vercel-alice");
  assert.equal(first.principal.attributes.webSessionOwner, first.key);
  assert.equal(first.principal.attributes.picture, "https://example.com/alice.png");
  assert.equal(second.principal.attributes.picture, undefined);
  const other = viewerFromVerifiedSession({
    user: { vercelSubject: "vercel-bob", name: "Alice", email: "old@example.com" },
  })!;
  assert.notEqual(first.key, other.key);
});
test("missing identity or an old cookie without the provider subject grants no owner", () => {
  assert.equal(viewerFromVerifiedSession(null), null);
  assert.equal(
    viewerFromVerifiedSession({ user: { name: "Alice", email: "alice@example.com" } }),
    null,
  );
});
