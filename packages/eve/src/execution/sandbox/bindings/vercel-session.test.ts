import { describe, expect, it, vi } from "vitest";

import type { Command, Sandbox as SdkSandbox } from "#compiled/@vercel/sandbox/index.js";
import {
  extractVercelEgressAuth,
  type VercelEgressAuth,
} from "#execution/sandbox/bindings/vercel-egress-auth.js";
import { vercelEgressRuleId } from "#execution/sandbox/bindings/vercel-egress-demand.js";
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

const DEMAND_TOKEN = "a".repeat(43);
const RULE_ID = vercelEgressRuleId("api.example.com", 0);
const DEMAND = { sandboxName: "sbx-under-test", token: DEMAND_TOKEN };

function sandbox(commands: Command[], markers: Map<string, string> = new Map()): SdkSandbox {
  return {
    fs: {
      rm: vi.fn(async (path: string) => {
        markers.delete(path.split("/").at(-1)!);
      }),
    },
    name: "sbx-under-test",
    readFile: vi.fn(async ({ path }: { path: string }) => {
      const content = markers.get(path.split("/").at(-1)!);
      return content === undefined ? null : new Response(content).body;
    }),
    runCommand: vi.fn(async () => commands.shift()!),
    update: vi.fn(async () => {}),
  } as never;
}

function onRequestEgressAuth(getToken: () => Promise<{ token: string }>): VercelEgressAuth {
  const { egressAuth } = extractVercelEgressAuth({
    authProxyBaseUrl: "https://eve.example.com",
    credentialResolution: "on-request",
    networkPolicy: {
      allow: {
        "api.example.com": [
          {
            auth: { getToken },
            transform: ({ token }: { token: string }) => [
              { headers: { authorization: `Bearer ${token}` } },
            ],
          },
        ],
      },
    },
  });
  return egressAuth!;
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
    const markers = new Map([[RULE_ID, DEMAND_TOKEN]]);
    const sdk = sandbox([command(22)], markers);
    const getToken = vi.fn(async () => ({ token: "tok" }));
    const egressAuth = onRequestEgressAuth(getToken);
    const handle = createVercelSandboxHandle({
      demand: DEMAND,
      egressAuth,
      sandbox: sdk,
      sessionKey: "session-settle",
    });

    const process = await handle.session.spawn({ command: "curl https://api.example.com" });
    await expect(process.wait()).resolves.toEqual({ exitCode: 22 });

    expect(getToken).toHaveBeenCalledOnce();
    expect(sdk.update).toHaveBeenCalledWith({
      networkPolicy: egressAuth.buildPolicy(new Map([[RULE_ID, { token: "tok" }]]), DEMAND),
    });
    expect(markers.size).toBe(0);
    expect(sdk.runCommand).toHaveBeenCalledOnce();
  });

  it("ignores forged demand markers that do not carry the proxy-attested token", async () => {
    const markers = new Map([[RULE_ID, "forged-by-sandbox-code"]]);
    const sdk = sandbox([command(22)], markers);
    const getToken = vi.fn(async () => ({ token: "tok" }));
    const handle = createVercelSandboxHandle({
      demand: DEMAND,
      egressAuth: onRequestEgressAuth(getToken),
      sandbox: sdk,
      sessionKey: "session-forged",
    });

    const process = await handle.session.spawn({ command: "curl https://api.example.com" });
    await expect(process.wait()).resolves.toEqual({ exitCode: 22 });

    expect(getToken).not.toHaveBeenCalled();
    expect(sdk.update).not.toHaveBeenCalled();
    expect(markers.size).toBe(1);
  });

  it("rebuilds the managed policy from live credentials in useSessionFn", async () => {
    const markers = new Map([[RULE_ID, DEMAND_TOKEN]]);
    const sdk = sandbox([command(22)], markers);
    const egressAuth = onRequestEgressAuth(async () => ({ token: "tok" }));
    const handle = createVercelSandboxHandle({
      demand: DEMAND,
      egressAuth,
      sandbox: sdk,
      sessionKey: "session-rebuild",
    });

    const process = await handle.session.spawn({ command: "curl https://api.example.com" });
    await process.wait();
    vi.mocked(sdk.update).mockClear();

    await handle.useSessionFn();

    // The credential that settled mid-step must survive a policy rebuild.
    expect(sdk.update).toHaveBeenCalledWith({
      networkPolicy: egressAuth.buildPolicy(new Map([[RULE_ID, { token: "tok" }]]), DEMAND),
    });
  });

  it("persists the demand token so the next step can verify surviving markers", async () => {
    const sdk = sandbox([]);
    const handle = createVercelSandboxHandle({
      demand: DEMAND,
      egressAuth: onRequestEgressAuth(async () => ({ token: "tok" })),
      sandbox: sdk,
      sessionKey: "session-capture",
    });

    await expect(handle.captureState()).resolves.toEqual({
      backendName: "vercel",
      metadata: { demandToken: DEMAND_TOKEN, sandboxName: "sbx-under-test" },
      sessionKey: "session-capture",
    });
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
    const handle = createVercelSandboxHandle({
      egressAuth: onRequestEgressAuth(async () => ({ token: "tok" })),
      sandbox: sdk,
      sessionKey: "session-reject",
    });

    await expect(handle.useSessionFn({ networkPolicy: "allow-all" })).rejects.toThrow(
      /onSession.*cannot replace/,
    );
    expect(sdk.update).not.toHaveBeenCalled();
  });
});
