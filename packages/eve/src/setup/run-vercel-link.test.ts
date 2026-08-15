import { describe, expect, it, vi } from "vitest";

import { runVercel } from "#setup/primitives/index.js";

import { runVercelEnvPull, VERCEL_ENV_PULL_TIMEOUT_MS } from "./run-vercel-link.js";

vi.mock("#setup/primitives/index.js", () => ({
  runVercel: vi.fn(),
}));

const mockedRunVercel = vi.mocked(runVercel);

describe("runVercelEnvPull", () => {
  it("closes stdin and bounds the non-interactive env pull", async () => {
    mockedRunVercel.mockResolvedValue(true);
    const signal = new AbortController().signal;
    const onOutput = vi.fn();

    await expect(runVercelEnvPull("/tmp/agent", onOutput, signal)).resolves.toBe(true);

    expect(mockedRunVercel).toHaveBeenCalledWith(["env", "pull", "--yes"], {
      cwd: "/tmp/agent",
      onOutput,
      signal,
      nonInteractive: true,
      timeoutMs: VERCEL_ENV_PULL_TIMEOUT_MS,
    });
  });
});
