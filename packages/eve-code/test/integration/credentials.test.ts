import assert from "node:assert/strict";
import test from "node:test";

import type { MutableNetworkSandboxSession, SandboxSession } from "eve/sandbox";

import { authenticateGitHub, authenticateVercel } from "../../extension/lib/credentials.ts";

test("default firewall authentication merges GitHub and Vercel hosts", async () => {
  const policies: unknown[] = [];
  const sandbox = fakeSandbox({ setPolicy: (policy) => policies.push(policy) });

  await authenticateGitHub(sandbox, { token: "github-token" });
  await authenticateVercel(sandbox, { token: "vercel-token" });

  const final = policies.at(-1) as { allow: Record<string, unknown> };
  assert.deepEqual(Object.keys(final.allow).sort(), [
    "*",
    "api.github.com",
    "api.vercel.com",
    "github.com",
    "vercel.com",
  ]);
  assert.deepEqual(final.allow["api.vercel.com"], [
    { transform: [{ headers: { authorization: "Bearer vercel-token" } }] },
  ]);
});

test("custom broker receives complete rules for each credential", async () => {
  const received: Record<string, Record<string, string>>[] = [];
  const sandbox = fakeSandbox({});
  const broker = async (
    _sandbox: SandboxSession,
    rules: Record<string, Record<string, string>>,
  ) => {
    received.push(rules);
  };

  await authenticateGitHub(sandbox, { token: "github-token", broker });
  await authenticateVercel(sandbox, { token: "vercel-token", broker });

  assert.deepEqual(Object.keys(received[0] ?? {}).sort(), ["api.github.com", "github.com"]);
  assert.deepEqual(Object.keys(received[1] ?? {}).sort(), ["api.vercel.com", "vercel.com"]);
});

test("firewall delivery fails precisely without mutable network policy", async () => {
  const { setNetworkPolicy: _omitted, ...fixed } = fakeSandbox({});
  const sandbox = fixed as SandboxSession;

  for (const authenticate of [authenticateGitHub, authenticateVercel]) {
    await assert.rejects(
      authenticate(sandbox, { token: "token" }),
      /requires a sandbox provider with mutable network policy \(setNetworkPolicy\)\. Use delivery: "command" or pass a broker callback\./u,
    );
  }
});

test("command delivery configures git and writes both CLI tokens", async () => {
  const commands: string[] = [];
  const writes = new Map<string, string>();
  const sandbox = fakeSandbox({ commands, writes });

  await authenticateGitHub(sandbox, { token: "github-token", delivery: "command" });
  await authenticateVercel(sandbox, { token: "vercel-token", delivery: "command" });

  assert.match(commands[0] ?? "", /git config --global.*extraheader/u);
  const environment = writes.get("/workspace/.eve-code/env") ?? "";
  assert.ok(environment.includes("export GH_TOKEN='github-token'"));
  assert.ok(environment.includes("export VERCEL_TOKEN='vercel-token'"));
});

function fakeSandbox(input: {
  commands?: string[];
  writes?: Map<string, string>;
  setPolicy?: (policy: unknown) => void;
}): SandboxSession {
  const writes = input.writes ?? new Map<string, string>();
  const sandbox: Pick<SandboxSession, "resolvePath" | "readTextFile" | "writeTextFile" | "run"> &
    Pick<MutableNetworkSandboxSession, "setNetworkPolicy"> = {
    resolvePath(path: string) {
      return `/workspace/${path}`.replace(/\/$/u, "");
    },
    async readTextFile({ path }: { path: string }) {
      return writes.get(path) ?? null;
    },
    async writeTextFile({ path, content }: { path: string; content: string }) {
      writes.set(path, content);
    },
    async run({ command }: { command: string }) {
      input.commands?.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async setNetworkPolicy(policy) {
      input.setPolicy?.(policy);
    },
  };
  return sandbox as SandboxSession;
}
