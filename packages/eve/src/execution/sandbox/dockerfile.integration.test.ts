import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSandboxDockerfile } from "#execution/sandbox/dockerfile.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { mkdir, writeFile } from "node:fs/promises";

const createScratchDirectory = useTemporaryDirectories();

describe("resolveSandboxDockerfile", () => {
  it("discovers and hashes the colocated Docker build context", async () => {
    const agentRoot = await createScratchDirectory("eve-dockerfile-");
    const sandboxRoot = join(agentRoot, "sandbox");
    await mkdir(sandboxRoot, { recursive: true });
    await writeFile(join(sandboxRoot, "Dockerfile"), "FROM alpine\nCOPY setup.sh /setup.sh\n");
    await writeFile(join(sandboxRoot, "setup.sh"), "#!/bin/sh\n");

    const first = await resolveSandboxDockerfile(agentRoot);
    await writeFile(join(sandboxRoot, "setup.sh"), "#!/bin/sh\necho changed\n");
    const second = await resolveSandboxDockerfile(agentRoot);

    expect(first).toMatchObject({
      contextPath: sandboxRoot,
      path: join(sandboxRoot, "Dockerfile"),
    });
    expect(second?.contentHash).not.toBe(first?.contentHash);
  });

  it("returns undefined when the sandbox has no Dockerfile", async () => {
    const agentRoot = await createScratchDirectory("eve-no-dockerfile-");
    await expect(resolveSandboxDockerfile(agentRoot)).resolves.toBeUndefined();
  });
});
