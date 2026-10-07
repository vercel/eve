import assert from "node:assert/strict";
import test from "node:test";

(globalThis as Record<symbol, unknown>)[Symbol.for("eve.ext-config-scope")] =
  "eve-code-eve-gh-agent-test";
const extension = (await import("../../extension/extension.ts")).default;
const agent = (await import("../../extension/subagents/eve_gh/agent.ts")).default;
const sandboxModule = await import("../../extension/subagents/eve_gh/sandbox.ts");
const bash = (await import("../../extension/subagents/eve_gh/tools/bash.ts")).default;
const readFile = (await import("../../extension/subagents/eve_gh/tools/read_file.ts")).default;
const writeFile = (await import("../../extension/subagents/eve_gh/tools/write_file.ts")).default;

test("eve-gh agent is absent by default and the flag exposes it without loading secrets", async () => {
  const resolve = agent.events["turn.started"]!;
  extension({});
  assert.equal(await resolve(undefined as never, undefined as never), null);
  const resolveOptions = () => {
    throw new Error("Availability must not resolve credentials");
  };
  const auth = {} as never;
  extension({ eveGh: { auth, resolveOptions } });
  assert.equal(await resolve(undefined as never, undefined as never), null);
  extension({ eveGh: { enabled: true, auth, resolveOptions } });
  const enabled = await resolve(undefined as never, undefined as never);
  assert.ok(enabled);
  assert.equal(enabled.defaultTools, false);
  extension({ eveGh: { enabled: false, auth, resolveOptions } });
  assert.equal(await resolve(undefined as never, undefined as never), null);
});

test("every eve-gh sandbox tool checks the opt-in before authorization or access", async () => {
  extension({});
  const context = {
    getToken: () => assert.fail("disabled tool requested a token"),
    getSandbox: () => assert.fail("disabled tool requested a sandbox"),
  };
  for (const [tool, input] of [
    [bash, { command: "pwd" }],
    [readFile, { path: "/workspace/README.md" }],
    [writeFile, { path: "/workspace/test.txt", content: "hello" }],
  ] as const) {
    await assert.rejects(
      Promise.resolve(tool.execute(input as never, context as never)),
      /disabled/,
    );
  }
});

test("eve-gh child owns a dedicated template-free provider", () => {
  extension({});
  assert.equal(sandboxModule.environment.provider, "eve-gh");
  assert.equal(typeof sandboxModule.default, "function");
});
