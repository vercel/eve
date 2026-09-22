import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { writeSandboxPreparedArtifactsManifest } from "#runtime/sandbox/prepared-artifacts.js";
import { prewarmAppSandboxes } from "./prewarm.js";
import { ensureDevelopmentSandboxesPrepared } from "./development-lazy-prewarm.js";

vi.mock("./prewarm.js", () => ({ prewarmAppSandboxes: vi.fn() }));
const scratch = useTemporaryDirectories();

async function fixture() {
  const appRoot = await scratch("eve-lazy-preparation-");
  const compileDirectoryPath = join(appRoot, ".eve", "compile");
  await mkdir(compileDirectoryPath, { recursive: true });
  return {
    input: {
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
      nodeId: "__root__",
      providerName: "test",
    },
    async publish() {
      await writeSandboxPreparedArtifactsManifest({
        compileDirectoryPath,
        entries: [{ nodeId: "__root__", providerName: "test", artifact: null }],
      });
    },
  };
}

describe("lazy development preparation", () => {
  it("deduplicates concurrent first access and reuses published artifacts", async () => {
    const app = await fixture();
    vi.mocked(prewarmAppSandboxes)
      .mockReset()
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        await app.publish();
      });
    await Promise.all([
      ensureDevelopmentSandboxesPrepared(app.input),
      ensureDevelopmentSandboxesPrepared(app.input),
    ]);
    await ensureDevelopmentSandboxesPrepared(app.input);
    expect(prewarmAppSandboxes).toHaveBeenCalledTimes(1);
  });

  it("releases the lock after failure and retries on next access", async () => {
    const app = await fixture();
    vi.mocked(prewarmAppSandboxes)
      .mockReset()
      .mockRejectedValueOnce(new Error("setup failed"))
      .mockImplementationOnce(app.publish);
    await expect(ensureDevelopmentSandboxesPrepared(app.input)).rejects.toThrow("setup failed");
    await expect(ensureDevelopmentSandboxesPrepared(app.input)).resolves.toBeUndefined();
    expect(prewarmAppSandboxes).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce different generations sharing the same authored app", async () => {
    const one = await fixture();
    const two = await fixture();
    vi.mocked(prewarmAppSandboxes)
      .mockReset()
      .mockImplementation(async (input) => {
        if (
          input.compiledArtifactsSource?.kind === "disk" &&
          input.compiledArtifactsSource.appRoot === one.input.compiledArtifactsSource.appRoot
        )
          await one.publish();
        else await two.publish();
      });
    await Promise.all(
      [one, two].map((app) =>
        ensureDevelopmentSandboxesPrepared({
          ...app.input,
          compiledArtifactsSource: {
            ...app.input.compiledArtifactsSource,
            sandboxAppRoot: "/same-authored-app",
          },
        }),
      ),
    );
    expect(prewarmAppSandboxes).toHaveBeenCalledTimes(2);
  });
});
