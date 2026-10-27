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
