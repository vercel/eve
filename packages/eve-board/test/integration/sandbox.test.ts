import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { defineBoardSandbox } from "../../extension/lib/sandbox.ts";

afterEach(() => {
  delete process.env.BOARD_TOKEN;
});

const sandbox = defineBoardSandbox(() => ({
  url: "https://team.example.com/api/board",
  profile: "support",
}));

test("the sandbox rules give vb the agent's board identity on board routes, never on webhooks", async () => {
  process.env.BOARD_TOKEN = "board-token";
  const rules = await sandbox.rules({ session: "session-1", scope: "dev/=read,post" });

  const [rule] = rules["team.example.com"] ?? [];
  assert.ok(rule && "transform" in rule && rule.match?.path && "regex" in rule.match.path);
  assert.deepEqual(rule.transform[0]?.headers, {
    authorization: "Bearer board-token",
    "x-board-profile": "support",
    "x-board-scope": "dev/=read,post",
    "x-board-session": "session-1",
  });

  const routes = new RegExp(rule.match.path.regex, "u");
  for (const path of ["/api/board", "/api/board/me", "/api/board/messages/812/reactions"]) {
    assert.ok(routes.test(path), `${path} should carry the board token`);
  }
  // A webhook takes any token of the project, so the sandbox could forge platform events there.
  for (const path of ["/api/board/webhooks/slack", "/api/board/watchers", "/other/messages"]) {
    assert.ok(!routes.test(path), `${path} must not carry the board token`);
  }
});

test("the sandbox env points vb at the board with a placeholder token", () => {
  assert.deepEqual(sandbox.env(), {
    BOARD_TOKEN: "set-by-the-network-policy",
    BOARD_URL: "https://team.example.com/api/board",
  });
});

/** An unsigned JWT that expires `seconds` from now; `renew()` only reads its `exp`. */
function tokenExpiringIn(seconds: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: Math.floor(Date.now() / 1000) + seconds })}.`;
}

test("renew installs the board rules with the sandbox's own, and again only near the token's end", async () => {
  const installed: unknown[] = [];
  const target = { setNetworkPolicy: async (policy: unknown) => void installed.push(policy) };
  const gateway = { "ai-gateway.vercel.sh": [] };

  process.env.BOARD_TOKEN = tokenExpiringIn(3600);
  await sandbox.renew(target, { session: "fresh", allow: gateway });
  await sandbox.renew(target, { session: "fresh", allow: gateway });
  assert.equal(installed.length, 1);
  assert.deepEqual(Object.keys((installed[0] as { allow: object }).allow), [
    "ai-gateway.vercel.sh",
    "team.example.com",
  ]);

  // A turn's start installs whatever was installed before, since eve may have recreated the sandbox.
  await sandbox.renew(target, { session: "fresh", force: true });
  assert.equal(installed.length, 2);

  process.env.BOARD_TOKEN = tokenExpiringIn(60);
  await sandbox.renew(target, { session: "ending" });
  await sandbox.renew(target, { session: "ending" });
  assert.equal(installed.length, 4);
});
