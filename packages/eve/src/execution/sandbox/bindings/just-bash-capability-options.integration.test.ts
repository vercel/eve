import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJustBashSandboxBackend } from "#execution/sandbox/bindings/just-bash.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

// Capture every `Sandbox.create(options)` call so we can assert which
// capability options the just-bash backend forwards. `vi.hoisted` runs
// before the `vi.mock` factory, so the array is in scope inside it.
const created = vi.hoisted(() => ({ options: [] as unknown[] }));

// A minimal functional stand-in for the optional `just-bash` package:
// just enough surface for `createBashSandbox` to build a sandbox handle
// without a real interpreter. `Sandbox.create` records its options.
vi.mock("just-bash", () => {
  class ReadWriteFs {
    async mkdir(): Promise<void> {}
    async writeFile(): Promise<void> {}
    async readFileBuffer(): Promise<Uint8Array> {
      return new Uint8Array();
    }
    async rm(): Promise<void> {}
  }
  const Sandbox = {
    create: vi.fn(async (options: unknown) => {
      created.options.push(options);
      return {
        bashEnvInstance: { getEnv: () => ({}) },
        async runCommand() {
          return {};
        },
        async stop() {},
      };
    }),
  };
  return { ReadWriteFs, Sandbox };
});

const createScratchDirectory = useTemporaryDirectories();

beforeEach(() => {
  created.options.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("just-bash backend forwards capability options to Sandbox.create", () => {
  it("threads author-supplied SandboxOptions through to the interpreter", async () => {
    const appRoot = await createScratchDirectory("eve-just-bash-options-");
    const backend = createJustBashSandboxBackend({
      createOptions: {
        defenseInDepth: false,
        maxCallDepth: 64,
        maxCommandCount: 5000,
        maxLoopIterations: 100000,
        timeoutMs: 30000,
      },
    });

    await backend.create({
      runtimeContext: { appRoot },
      sessionKey: "session-with-options",
      templateKey: null,
    });

    expect(created.options).toHaveLength(1);
    expect(created.options[0]).toMatchObject({
      defenseInDepth: false,
      maxCallDepth: 64,
      maxCommandCount: 5000,
      maxLoopIterations: 100000,
      timeoutMs: 30000,
      // Untouched defaults the backend has always set.
      network: { dangerouslyAllowFullInternetAccess: true },
    });
  });

  it("leaves the Sandbox.create call unchanged when no options are passed", async () => {
    const appRoot = await createScratchDirectory("eve-just-bash-no-options-");
    const backend = createJustBashSandboxBackend();

    await backend.create({
      runtimeContext: { appRoot },
      sessionKey: "session-without-options",
      templateKey: null,
    });

    expect(created.options).toHaveLength(1);
    const options = created.options[0] as Record<string, unknown>;
    // Every capability field defaults to just-bash's own behavior, i.e.
    // it is forwarded as `undefined` (equivalent to absent).
    expect(options.defenseInDepth).toBeUndefined();
    expect(options.maxCallDepth).toBeUndefined();
    expect(options.maxCommandCount).toBeUndefined();
    expect(options.maxLoopIterations).toBeUndefined();
    expect(options.timeoutMs).toBeUndefined();
    // The pre-existing hardcoded defaults remain.
    expect(options.network).toEqual({ dangerouslyAllowFullInternetAccess: true });
  });
});
