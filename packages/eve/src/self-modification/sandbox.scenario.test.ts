import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSandboxEnvironmentHarness } from "#internal/testing/sandbox-provider-harness.js";
import { installLocalDevCapabilityEnvironment } from "#runtime/local-dev-capability.js";
import {
  getBoundSandboxEnvironment,
  runWithSandboxConstructorRuntime,
  type SandboxSelectorContext,
} from "#shared/sandbox-environment.js";

import { defineSelfModificationSandbox } from "./sandbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function withLocalDevCapability<T>(appRoot: string, callback: () => Promise<T>): Promise<T> {
  const restore = installLocalDevCapabilityEnvironment({
    appRoot,
    serverUrl: "http://127.0.0.1:3000",
  });
  try {
    return await callback();
  } finally {
    restore();
  }
}

async function createAppRoot(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-self-modification-sandbox-"));
  temporaryDirectories.push(appRoot);
  await mkdir(join(appRoot, "agent"), { recursive: true });
  await mkdir(join(appRoot, ".eve/traces/v1/trace-1/segments"), { recursive: true });
  await mkdir(join(appRoot, ".eve/logs"), { recursive: true });
  await mkdir(join(appRoot, "node_modules/eve/docs"), { recursive: true });
  await writeFile(join(appRoot, "package.json"), '{"name":"self-mod-app"}\n');
  await writeFile(join(appRoot, ".eve/traces/v1/trace-1/segments/span.otlp.json"), "trace\n");
  await writeFile(join(appRoot, ".eve/logs/dev-test.log"), "diagnostic log\n");
  await writeFile(join(appRoot, "node_modules/eve/docs/README.md"), "installed eve docs\n");
  return appRoot;
}

const selectorContext: SandboxSelectorContext = {
  session: {
    auth: { current: null, initiator: null },
    id: "self-mod-session",
    turn: { id: "turn-1", sequence: 0 },
  },
};

async function openSelfModificationSandbox(input: {
  readonly runtimeRoot: string;
  readonly storagePath: string;
}) {
  const selector = defineSelfModificationSandbox();
  const environment = getBoundSandboxEnvironment(selector);
  expect(environment?.provider).toBe("host");
  const harness = createSandboxEnvironmentHarness(environment!);
  const prepared = await harness.prepare({
    appRoot: input.runtimeRoot,
    storagePath: input.storagePath,
  });
  let sessionState: unknown;
  const opened = await runWithSandboxConstructorRuntime(
    {
      async open({ options }) {
        const started = await harness.start({
          appRoot: input.runtimeRoot,
          options,
          prepared,
          sandboxName: "self-mod-session",
        });
        sessionState = started.state;
        return started.sandbox as never;
      },
    },
    () => selector(selectorContext),
  );
  return {
    cleanup: () =>
      harness.endSession({
        appRoot: input.runtimeRoot,
        sandboxName: "self-mod-session",
        state: sessionState as never,
      }),
    sandbox: opened,
  };
}

describe("self-modification sandbox", () => {
  it.skipIf(process.platform === "win32")(
    "opens HostSandbox in the capability's authored root instead of the runtime snapshot",
    async () => {
      vi.stubEnv("EVE_DEV", "1");
      const authoredRoot = await createAppRoot();
      const runtimeRoot = await createAppRoot();
      const storagePath = await mkdtemp(join(tmpdir(), "eve-self-modification-storage-"));
      temporaryDirectories.push(storagePath);

      await withLocalDevCapability(authoredRoot, async () => {
        const { cleanup, sandbox } = await openSelfModificationSandbox({
          runtimeRoot,
          storagePath,
        });
        try {
          expect(sandbox.resolvePath(".")).toBe(authoredRoot);
          expect(await sandbox.readTextFile({ path: "package.json" })).toBe(
            '{"name":"self-mod-app"}\n',
          );
          expect(
            await sandbox.readTextFile({ path: ".eve/traces/v1/trace-1/segments/span.otlp.json" }),
          ).toBe("trace\n");
          expect(await sandbox.readTextFile({ path: ".eve/logs/dev-test.log" })).toBe(
            "diagnostic log\n",
          );
          expect(await sandbox.readTextFile({ path: "node_modules/eve/docs/README.md" })).toBe(
            "installed eve docs\n",
          );

          await sandbox.writeTextFile({ content: "authored\n", path: "agent/instructions.md" });
          const pwd = await sandbox.run({ command: "pwd -P" });
          expect(pwd.exitCode).toBe(0);
          expect(pwd.stdout.trim()).toBe(await realpath(authoredRoot));
        } finally {
          await cleanup();
        }
      });

      expect(await readFile(join(authoredRoot, "agent/instructions.md"), "utf8")).toBe(
        "authored\n",
      );
      await expect(readFile(join(runtimeRoot, "agent/instructions.md"), "utf8")).rejects.toThrow(
        /ENOENT/u,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects opening without eve dev facilities",
    async () => {
      vi.stubEnv("EVE_DEV", "1");
      const selector = defineSelfModificationSandbox();

      await expect(Promise.resolve().then(() => selector(selectorContext))).rejects.toThrow(
        "Self-modification requires eve dev facilities",
      );
    },
  );

  it("binds a no-op disabled provider when local self-modification is inactive", async () => {
    vi.stubEnv("EVE_DEV", undefined);
    const selector = defineSelfModificationSandbox();
    const environment = getBoundSandboxEnvironment(selector);
    expect(environment?.provider).toBe("self-modification-disabled");
    const harness = createSandboxEnvironmentHarness(environment!);
    await expect(harness.prepare({ appRoot: "/virtual" })).resolves.toEqual({});
    await expect(
      harness.start({ appRoot: "/virtual", sandboxName: "self-mod-session" }),
    ).rejects.toThrow("Self-modification sandbox is disabled");
  });
});
