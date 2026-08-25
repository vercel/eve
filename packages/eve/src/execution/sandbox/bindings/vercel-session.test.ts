import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Command, Sandbox as SdkSandbox } from "#compiled/@vercel/sandbox/index.js";
import { AuthorizationInterrupt } from "#harness/authorization-interrupt.js";
import { requestAuthorization } from "#harness/authorization.js";
import { resolveVercelEgressPolicy } from "#execution/sandbox/bindings/vercel-egress-auth.js";
import { vercelEgressRuleId } from "#execution/sandbox/bindings/vercel-egress-demand.js";
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

const DEMAND_TOKEN = "a".repeat(43);
const RULE_ID = vercelEgressRuleId("api.example.com", 0);

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

function onRequestEgressAuth() {
  return {
    buildPolicy: vi.fn(
      (credentials: ReadonlyMap<string, { token: string }>) =>
        `policy:${[...credentials.keys()].join(",")}`,
    ),
    clearedPolicy: "policy:",
    eagerRuleIds: [],
    rules: new Map([[RULE_ID, { credentialResolution: "on-request", id: RULE_ID }]]),
  } as never;
}

describe("Vercel on-request sandbox processes", () => {
  beforeEach(() => {
    vi.mocked(resolveVercelEgressPolicy).mockClear();
  });

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
    vi.mocked(resolveVercelEgressPolicy).mockResolvedValueOnce({
      credentials: new Map([[RULE_ID, { token: "tok" }]]),
      policy: `policy:${RULE_ID}`,
      unresolvedRuleIds: [],
    } as never);
    const handle = createVercelSandboxHandle(
      sdk,
      "session-key",
      onRequestEgressAuth(),
      undefined,
      new Map(),
      DEMAND_TOKEN,
    );

    const process = await handle.session.spawn({ command: "curl https://api.example.com" });
    await expect(process.wait()).resolves.toEqual({ exitCode: 22 });

    expect(resolveVercelEgressPolicy).toHaveBeenCalledWith(
      expect.anything(),
      "session-key",
      [RULE_ID],
      "sbx-under-test",
      DEMAND_TOKEN,
    );
    expect(sdk.update).toHaveBeenCalledWith({ networkPolicy: `policy:${RULE_ID}` });
    expect(markers.size).toBe(0);
    expect(sdk.runCommand).toHaveBeenCalledOnce();
  });

  it("ignores forged demand markers that do not carry the proxy-attested token", async () => {
    const markers = new Map([[RULE_ID, "forged-by-sandbox-code"]]);
    const sdk = sandbox([command(22)], markers);
    const handle = createVercelSandboxHandle(
      sdk,
      "session-key",
      onRequestEgressAuth(),
      undefined,
      new Map(),
      DEMAND_TOKEN,
    );

    const process = await handle.session.spawn({ command: "curl https://api.example.com" });
    await expect(process.wait()).resolves.toEqual({ exitCode: 22 });

    expect(resolveVercelEgressPolicy).not.toHaveBeenCalled();
    expect(sdk.update).not.toHaveBeenCalled();
    expect(markers.size).toBe(1);
  });

  it("keeps demand markers when authorization parks so resume can activate the credential", async () => {
    const markers = new Map([[RULE_ID, DEMAND_TOKEN]]);
    const sdk = sandbox([command(22)], markers);
    vi.mocked(resolveVercelEgressPolicy).mockRejectedValueOnce(
      new AuthorizationInterrupt(requestAuthorization([])),
    );
    const handle = createVercelSandboxHandle(
      sdk,
      "session-key",
      onRequestEgressAuth(),
      undefined,
      new Map(),
      DEMAND_TOKEN,
    );

    const process = await handle.session.spawn({ command: "curl https://api.example.com" });
    await expect(process.wait()).rejects.toBeInstanceOf(AuthorizationInterrupt);

    expect(markers.size).toBe(1);
    expect(sdk.update).not.toHaveBeenCalled();
  });

  it("persists the demand token so the next step can verify surviving markers", async () => {
    const sdk = sandbox([]);
    const handle = createVercelSandboxHandle(
      sdk,
      "session-key",
      onRequestEgressAuth(),
      undefined,
      new Map(),
      DEMAND_TOKEN,
    );

    await expect(handle.captureState()).resolves.toEqual({
      backendName: "vercel",
      metadata: { demandToken: DEMAND_TOKEN, sandboxName: "sbx-under-test" },
      sessionKey: "session-key",
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
