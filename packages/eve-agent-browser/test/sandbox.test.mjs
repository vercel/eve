import assert from "node:assert/strict";
import test from "node:test";

import {
  agentBrowserRevalidationKey,
  buildAgentBrowserCommand,
  installAgentBrowser,
  runAgentBrowser,
} from "@eve/agent-browwser/sandbox";

test("builds eve revalidation key from install options", () => {
  assert.equal(
    agentBrowserRevalidationKey({ installSpec: "agent-browser@1.2.3" }),
    "agent-browser:bootstrap-4:agent-browser@1.2.3:browser:system-deps",
  );
  assert.equal(
    agentBrowserRevalidationKey({
      installSpec: "agent-browser@1.2.3",
      installSystemDependencies: false,
    }),
    "agent-browser:bootstrap-4:agent-browser@1.2.3:browser:no-system-deps",
  );
});

test("builds eve shell command", () => {
  assert.equal(
    buildAgentBrowserCommand(["open", "https://example.com"], { session: "s1" }),
    "agent-browser --session s1 open https://example.com --json",
  );
});

test("installs agent-browser in an eve sandbox with cancellation", async () => {
  const commands = [];
  const controller = new AbortController();
  const sandbox = {
    async run({ command, signal }) {
      assert.equal(signal, controller.signal);
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  await installAgentBrowser(sandbox, {
    abortSignal: controller.signal,
    installSpec: "agent-browser@1.2.3",
  });

  assert.equal(commands.length, 3);
  assert.match(commands[0], /^if command -v apt-get/);
  assert.match(commands[0], /libglib2\.0-0t64/);
  assert.match(commands[0], /libasound2t64/);
  assert.match(commands[0], /libnss3-tools/);
  assert.match(commands[0], /sudo ldconfig; elif command -v dnf/);
  assert.match(commands[0], /sudo ldconfig; else echo/);
  assert.match(commands[0], /sudo dnf install -y --skip-broken -- glib2 nss nss-tools/);
  assert.equal(commands[1], "npm install -g agent-browser@1.2.3");
  assert.equal(commands[2], "agent-browser install");
});

test("skips eve system dependencies when explicitly disabled", async () => {
  const commands = [];
  const sandbox = {
    async run({ command }) {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  await installAgentBrowser(sandbox, {
    installSpec: "agent-browser@1.2.3",
    installSystemDependencies: false,
  });

  assert.deepEqual(commands, ["npm install -g agent-browser@1.2.3", "agent-browser install"]);
});

test("runs agent-browser through ctx.getSandbox with cancellation", async () => {
  const commands = [];
  const controller = new AbortController();
  const ctx = {
    async getSandbox() {
      return {
        async run({ command, signal }) {
          assert.equal(signal, controller.signal);
          commands.push(command);
          return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
        },
      };
    },
  };

  const result = await runAgentBrowser(ctx, ["open", "https://example.com"], {
    abortSignal: controller.signal,
  });

  assert.deepEqual(result.json, { ok: true });
  assert.equal(commands[0], "agent-browser --session eve-default open https://example.com --json");
});

test("accepts eve promise-like sandbox methods", async () => {
  const thenable = (value) => ({
    // oxlint-disable-next-line unicorn/no-thenable -- eve sandbox methods return PromiseLike.
    then(resolve) {
      resolve(value);
    },
  });
  const ctx = {
    getSandbox() {
      return thenable({
        run() {
          return thenable({ exitCode: 0, stdout: '{"ok":true}', stderr: "" });
        },
      });
    },
  };

  const result = await runAgentBrowser(ctx, ["snapshot"]);

  assert.deepEqual(result.json, { ok: true });
});

test("throws when eve sandbox command fails", async () => {
  const ctx = {
    async getSandbox() {
      return {
        async run() {
          return { exitCode: 2, stdout: "", stderr: "no chrome" };
        },
      };
    },
  };

  await assert.rejects(() => runAgentBrowser(ctx, ["snapshot"]), /no chrome/);
});
