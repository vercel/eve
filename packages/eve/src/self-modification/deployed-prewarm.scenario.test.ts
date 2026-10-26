import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAgentInWorkspace } from "#compiler/compile-agent.js";
import { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

import { DEPLOYED_SELF_MODIFICATION_CONFIG_PATH } from "./setup.js";

const createAppRoot = useTemporaryAppRoots();

describe("deployed self-modification prewarm", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prewarms off Vercel without preparing a Vercel snapshot", async () => {
    vi.stubEnv("EVE_DEV", undefined);
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("VERCEL")) vi.stubEnv(name, undefined);
    }
    const { appRoot } = await createAppRoot("eve-deployed-self-modification-prewarm-", {
      files: {
        "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a test agent.\n",
        [DEPLOYED_SELF_MODIFICATION_CONFIG_PATH]: [
          'import selfModification from "eve/self-modification/remote";',
          "export default selfModification({",
          '  github: { repository: "acme/agent", connector: "github/selfmod-acme-agent" },',
          "  authorize: () => false,",
          "});",
          "",
        ].join("\n"),
      },
    });
    await compileAgentInWorkspace({
      artifactLocations: {
        publishedRoot: join(appRoot, ".eve"),
        writeRoot: join(appRoot, ".eve"),
      },
      startPath: appRoot,
    });
    const vercelPreparations: unknown[] = [];

    await prewarmAppSandboxes({
      appRoot,
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot, {
        moduleMapLoaderPath: resolvePackageSourceFilePath(
          "src/internal/authored-module-map-loader.ts",
        ),
      }),
      // The root agent's default sandbox would build a local Docker image here;
      // only whether the remote child requests Vercel preparation is under test.
      dispatch: async ({ provider }) => {
        if (provider.providerName === "vercel") vercelPreparations.push(provider);
        return {};
      },
    });

    expect(vercelPreparations).toEqual([]);
  });
});
