import { describe, expect, it, vi } from "vitest";

import type { Command, Sandbox as SdkSandbox } from "#compiled/@vercel/sandbox/index.js";
import {
  createVercelInternalSandboxSession,
  createVercelNetworkPolicySetter,
  createVercelSandboxHandle,
} from "#execution/sandbox/bindings/vercel-session.js";

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

function sandbox(commands: Command[]): SdkSandbox {
  return {
    runCommand: vi.fn(async () => commands.shift()!),
    update: vi.fn(async () => {}),
  } as never;
}

describe("Vercel on-request sandbox processes", () => {
  it("allows authored policy replacement without on-request rules", async () => {
    const sdk = sandbox([]);

    await createVercelNetworkPolicySetter(sdk)("allow-all");

    expect(sdk.update).toHaveBeenCalledWith({ networkPolicy: "allow-all" });
  });

  it("does not inspect demand markers until the process is awaited", async () => {
    const sdk = sandbox([command(0)]);
    const hasDemand = vi.fn(async () => true);
    const session = createVercelInternalSandboxSession(sdk, "sandbox", {
      hasDemand,
      resolveDemand: async () => {},
    });

    const process = await session.spawn({ command: "background-worker" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hasDemand).not.toHaveBeenCalled();
    await process.kill();
  });

  it("does not resolve or replay when no route is demanded", async () => {
    const sdk = sandbox([command(0)]);
    const resolveDemand = vi.fn(async () => {});
    const session = createVercelInternalSandboxSession(sdk, "sandbox", {
      hasDemand: async () => false,
      resolveDemand,
    });

    const process = await session.spawn({ command: "curl https://api.example.com" });
    await expect(process.wait()).resolves.toEqual({ exitCode: 0 });
    expect(sdk.runCommand).toHaveBeenCalledOnce();
    expect(resolveDemand).not.toHaveBeenCalled();
  });

  it("streams output from a running command without retaining the full log", async () => {
    vi.useFakeTimers();
    try {
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
      const session = createVercelInternalSandboxSession(sdk, "sandbox", {
        hasDemand: async () => false,
        resolveDemand: async () => {},
      });

      const process = await session.spawn({ command: "long-running-command" });
      const reader = process.stdout.getReader();
      const waited = process.wait();
      const firstChunk = reader.read();
      await vi.advanceTimersByTimeAsync(101);

      await expect(firstChunk).resolves.toMatchObject({
        done: false,
        value: new TextEncoder().encode("progress\n"),
      });

      finish({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(0);
      await expect(waited).resolves.toEqual({ exitCode: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves a completed demand and replays the awaited command", async () => {
    const sdk = sandbox([command(0), command(0)]);
    let demanded = true;
    const resolveDemand = vi.fn(async () => {
      demanded = false;
    });
    const session = createVercelInternalSandboxSession(sdk, "sandbox", {
      hasDemand: async () => demanded,
      resolveDemand,
    });

    const process = await session.spawn({ command: "curl https://api.example.com" });
    await expect(process.wait()).resolves.toEqual({ exitCode: 0 });
    expect(resolveDemand).toHaveBeenCalledOnce();
    expect(sdk.runCommand).toHaveBeenCalledTimes(2);
  });

  it("discards output from a blocked attempt and exposes only the successful replay", async () => {
    const sdk = sandbox([
      command(22, [{ data: "curl: HTTP 428\n", stream: "stderr" }]),
      command(0, [{ data: '{"authorized":true}\n', stream: "stdout" }]),
    ]);
    let demanded = true;
    const session = createVercelInternalSandboxSession(sdk, "sandbox", {
      hasDemand: async () => demanded,
      resolveDemand: async () => {
        demanded = false;
      },
    });

    const process = await session.spawn({ command: "curl https://api.example.com" });
    const [result, stdout, stderr] = await Promise.all([
      process.wait(),
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(result).toEqual({ exitCode: 0 });
    expect(stdout).toBe('{"authorized":true}\n');
    expect(stderr).toBe("");
  });

  it("bounds repeated demand-driven replays", async () => {
    const sdk = sandbox(Array.from({ length: 5 }, () => command(0)));
    const session = createVercelInternalSandboxSession(sdk, "sandbox", {
      hasDemand: async () => true,
      resolveDemand: async () => {},
    });

    const process = await session.spawn({ command: "curl https://api.example.com" });
    await expect(process.wait()).rejects.toThrow(/exceeded 3 .* replays/);
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
