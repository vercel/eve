import type { Experimental_SandboxProcess } from "ai";
import { describe, expect, it, vi } from "vitest";

import { MIRROR_PREFETCH_COMMAND, prefetchMirror } from "./prefetch";

/* A started process whose completion the caller would have to wait for. */
const startedProcess = (): Experimental_SandboxProcess => ({
  kill: vi.fn(() => Promise.resolve()),
  stderr: new ReadableStream(),
  stdout: new ReadableStream(),
  wait: vi.fn(() => Promise.resolve({ exitCode: 0 })),
});

describe("prefetchMirror", () => {
  it("starts the warm script in the background without waiting for it", async () => {
    const process = startedProcess();
    const spawn = vi.fn(() => Promise.resolve(process));

    await prefetchMirror({ spawn });

    expect(spawn).toHaveBeenCalledWith({ command: MIRROR_PREFETCH_COMMAND });
    expect(MIRROR_PREFETCH_COMMAND).toContain(
      '$HOME/.agents/skills/search_content/scripts/sql" --warm'
    );
    expect(process.wait).not.toHaveBeenCalled();
  });

  it("logs and continues when the process cannot start", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spawn = vi.fn(() => Promise.reject(new Error("sandbox busy")));

    await expect(prefetchMirror({ spawn })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("contentful.mirror_prefetch_failed", {
      message: "sandbox busy",
    });
  });
});
