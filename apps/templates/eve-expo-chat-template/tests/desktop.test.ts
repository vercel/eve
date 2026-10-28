import { test } from "node:test";
import assert from "node:assert/strict";
// Runtime module is plain JS so the exact code uploaded to Sandbox is tested.
// @ts-expect-error standalone runtime module intentionally has no declaration file
import { DesktopAccess } from "../packages/start/desktop/runtime/access.mjs";
test("remote desktop login links are short-lived and single-use, and session cookies expire", () => {
  let time = 1000;
  const access = new DesktopAccess(() => time);
  assert.equal(access.session(""), false);
  const ticket = access.issue();
  const session = access.exchange(ticket)?.session;
  assert.ok(session);
  assert.equal(access.exchange(ticket), null);
  assert.equal(access.session(`other=1; eve-desktop=${session}`), true);
  assert.equal(access.session("eve-desktop=made-up"), false);
  time += 3600001;
  assert.equal(access.session(`eve-desktop=${session}`), false);
  const expired = access.issue();
  time += 300001;
  assert.equal(access.exchange(expired), null);
  access.prune();
  assert.equal(access.sessions.size, 0);
});
// @ts-expect-error standalone runtime module intentionally has no declaration file
import { authorizeDesktopSocket } from "../packages/start/desktop/runtime/access.mjs";
test("live preview tickets bind one dashboard origin, so local and deployed dashboards can share a desktop", () => {
  const access = new DesktopAccess();
  const desktopOrigin = "https://sb-test.vercel.run";
  const deployed = access.issue("https://agent.example");
  const local = access.issue("http://localhost:2000");
  const input = { desktopOrigin, cookie: undefined };
  // A ticket issued for one dashboard cannot be redeemed from another, and is then spent.
  assert.equal(
    authorizeDesktopSocket(access, {
      ...input,
      ticket: deployed,
      requestOrigin: "http://localhost:2000",
    }),
    null,
  );
  assert.equal(
    authorizeDesktopSocket(access, {
      ...input,
      ticket: deployed,
      requestOrigin: "https://agent.example",
    }),
    null,
  );
  const cookie = authorizeDesktopSocket(access, {
    ...input,
    ticket: local,
    requestOrigin: "http://localhost:2000",
  });
  assert.ok(cookie);
  assert.ok(access.session(cookie));
  assert.equal(
    authorizeDesktopSocket(access, {
      ...input,
      ticket: local,
      requestOrigin: "http://localhost:2000",
    }),
    null,
  );
  assert.equal(
    authorizeDesktopSocket(access, {
      ...input,
      ticket: access.issue("https://agent.example"),
      requestOrigin: "https://attacker.example",
    }),
    null,
  );
  // Session cookies are only accepted from the desktop's own page.
  assert.equal(
    authorizeDesktopSocket(access, { ...input, cookie, requestOrigin: "http://localhost:2000" }),
    null,
  );
  assert.equal(
    authorizeDesktopSocket(access, { ...input, cookie, requestOrigin: desktopOrigin }),
    cookie,
  );
});
