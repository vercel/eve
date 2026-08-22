import { describe, expect, it, vi } from "vitest";

import type { Command, Sandbox as SdkSandbox } from "#compiled/@vercel/sandbox/index.js";
import { SandboxAuthorizationInterrupt } from "#execution/sandbox/authorization-interrupt.js";
import { requestAuthorization } from "#harness/authorization.js";
import { resolveVercelEgressPolicy } from "#execution/sandbox/bindings/vercel-egress-auth.js";
import {
  createVercelInternalSandboxSession,
  createVercelNetworkPolicySetter,
  createVercelSandboxHandle,
} from "#execution/sandbox/bindings/vercel-session.js";

vi.mock("#execution/sandbox/bindings/vercel-egress-auth.js", () => ({
  resolveVercelEgressPolicy: vi.fn(),
}));

function command(
  exitCode = 0,
  logs: readonly { readonly data: string; readonly stream: "stdout" | "stderr" }[] = [],
): Command {
  return {
    async *logs() {
      yield* logs;
    },
    wait: vi.fn(async () => ({ exitCode })),
    kill: vi.fn(async () => {}),
  } as never;
}

function sandbox(commands: Command[], demandedRuleIds: string[] = []): SdkSandbox {
  return {
    fs: {
      rm: vi.fn(async (path: string) => {
        const ruleId = path.split("/").at(-1)!;
        const index = demandedRuleIds.indexOf(ruleId);
        if (index >= 0) demandedRuleIds.splice(index, 1);
      }),
    },
    name: "sbx-under-test",
    readFile: vi.fn(async ({ path }: { path: string }) =>
      demandedRuleIds.includes(path.split("/").at(-1)!) ? "demanded" : null,
    ),
    runCommand: vi.fn(async () => commands.shift()!),
    update: vi.fn(async () => {}),
  } as never;
}

function onRequestEgressAuth() {
  return {
    buildPolicy: vi.fn(
      (credentials: ReadonlyMap<string, { token: string }>) =>
        `policy:${[...credentials.keys()].join(",")}`,
    ),
    clearedPolicy: "policy:",
    eagerRuleIds: [],
    rules: new Map([["r0-0", { credentialResolution: "on-request", id: "r0-0" }]]),
  } as never;
}

describe("Vercel on-request sandbox processes", () => {
  it("allows authored policy replacement without on-request rules", async () => {
    const sdk = sandbox([]);

    await createVercelNetworkPolicySetter(sdk)("allow-all");

    expect(sdk.update).toHaveBeenCalledWith({ networkPolicy: "allow-all" });
  });

  it("does not inspect demand until the process is awaited", async () => {
    const sdk = sandbox([command(0)]);
    const settleDemand = vi.fn(async () => {});
    const session = createVercelInternalSandboxSession(sdk, "sandbox", settleDemand);

    const process = await session.spawn({ command: "background-worker" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settleDemand).not.toHaveBeenCalled();
    await process.kill();
  });

  it("never replays the command; the exit result stands after demand settles", async () => {
    const sdk = sandbox([command(22, [{ data: "curl: HTTP 428\n", stream: "stderr" }])]);
    const settleDemand = vi.fn(async () => {});
    const session = createVercelInternalSandboxSession(sdk, "sandbox", settleDemand);

    const process = await session.spawn({ command: "curl https://api.example.com" });
    const [result, stderr] = await Promise.all([
      process.wait(),
      new Response(process.stderr).text(),
    ]);

    expect(result).toEqual({ exitCode: 22 });
    expect(stderr).toBe("curl: HTTP 428\n");
    expect(settleDemand).toHaveBeenCalledOnce();
    expect(sdk.runCommand).toHaveBeenCalledOnce();
  });

  it("propagates settlement failures (e.g. authorization interrupts) from wait", async () => {
    const sdk = sandbox([command(0)]);
    const interrupt = new Error("authorization required");
    const session = createVercelInternalSandboxSession(sdk, "sandbox", async () => {
      throw interrupt;
    });

    const process = await session.spawn({ command: "curl https://api.example.com" });
    await expect(process.wait()).rejects.toBe(interrupt);
    expect(sdk.runCommand).toHaveBeenCalledOnce();
  });

  it("streams output while the command runs", async () => {
    let finish!: (result: { exitCode: number }) => void;
    const runningCommand = {
      async *logs() {
        yield { data: "progress\n", stream: "stdout" as const };
      },
      wait: vi.fn(
        async () =>
          await new Promise<{ exitCode: number }>((resolve) => {
            finish = resolve;
          }),
      ),
      kill: vi.fn(async () => {}),
    } as never;
    const sdk = sandbox([runningCommand]);
    const session = createVercelInternalSandboxSession(sdk, "sandbox", async () => {});

    const process = await session.spawn({ command: "long-running-command" });
    const reader = process.stdout.getReader();
    const waited = process.wait();

    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: new TextEncoder().encode("progress\n"),
    });

    finish({ exitCode: 0 });
    await expect(waited).resolves.toEqual({ exitCode: 0 });
  });

  it("resolves a demanded credential after the command exits and clears the marker", async () => {
    const demanded = ["r0-0"];
    const sdk = sandbox([command(22)], demanded);
    vi.mocked(resolveVercelEgressPolicy).mockResolvedValueOnce({
      credentials: new Map([["r0-0", { token: "tok" }]]),
      policy: "policy:r0-0",
      unresolvedRuleIds: [],
    } as never);
    const handle = createVercelSandboxHandle(sdk, "session-key", onRequestEgressAuth(), undefined);

    const process = await handle.session.spawn({ command: "curl https://api.example.com" });
    await expect(process.wait()).resolves.toEqual({ exitCode: 22 });

    expect(resolveVercelEgressPolicy).toHaveBeenCalledWith(
      expect.anything(),
      "session-key",
      ["r0-0"],
      "sbx-under-test",
    );
    expect(sdk.update).toHaveBeenCalledWith({ networkPolicy: "policy:r0-0" });
    expect(demanded).toEqual([]);
    expect(sdk.runCommand).toHaveBeenCalledOnce();
  });

  it("keeps demand markers when authorization parks so resume can activate the credential", async () => {
    const demanded = ["r0-0"];
    const sdk = sandbox([command(22)], demanded);
    vi.mocked(resolveVercelEgressPolicy).mockRejectedValueOnce(
      new SandboxAuthorizationInterrupt(requestAuthorization([])),
    );
    const handle = createVercelSandboxHandle(sdk, "session-key", onRequestEgressAuth(), undefined);

    const process = await handle.session.spawn({ command: "curl https://api.example.com" });
    await expect(process.wait()).rejects.toBeInstanceOf(SandboxAuthorizationInterrupt);

    expect(demanded).toEqual(["r0-0"]);
    expect(sdk.update).not.toHaveBeenCalled();
  });

  it("rejects authored policy replacement for a managed session", async () => {
    const sdk = sandbox([]);
    await expect(createVercelNetworkPolicySetter(sdk, true)("allow-all")).rejects.toThrow(
      /setNetworkPolicy.*cannot replace/,
    );
    expect(sdk.update).not.toHaveBeenCalled();
  });

  it("rejects onSession policy replacement for managed auth rules", async () => {
    const sdk = sandbox([]);
    const handle = createVercelSandboxHandle(
      sdk,
      "sandbox",
      {
        buildPolicy: () => "deny-all",
        clearedPolicy: "deny-all",
        eagerRuleIds: [],
        rules: new Map(),
      },
      "deny-all",
    );

    await expect(handle.useSessionFn({ networkPolicy: "allow-all" })).rejects.toThrow(
      /onSession.*cannot replace/,
    );
    expect(sdk.update).not.toHaveBeenCalled();
  });
});
