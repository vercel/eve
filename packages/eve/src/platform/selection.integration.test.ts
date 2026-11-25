import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import {
  authoredPlatformModule,
  loadPlatformBuild,
  loadPlatformDeclaration,
  selectPlatformModule,
} from "#platform/selection.js";

const createAppRoot = useTemporaryAppRoots();
const declarationModule = JSON.stringify(
  resolvePackageSourceFilePath("src/platform/declaration.ts"),
);
const workflowEngineModule = JSON.stringify(
  resolvePackageSourceFilePath("src/platform/workflow-engine.ts"),
);
const ALICE_DEPLOYMENT = [
  "  deployment: () => ({",
  '    environment: () => "production",',
  '    deploymentId: () => "dpl_alice",',
  "    host: () => undefined,",
  "    scope: () => undefined,",
  "  }),",
];

function workflowPlatform(world: string): string {
  return [
    `import { definePlatform } from ${declarationModule};`,
    `import { workflowEngine } from ${workflowEngineModule};`,
    "export default definePlatform({",
    ...ALICE_DEPLOYMENT,
    `  durable: () => workflowEngine({ world: ${JSON.stringify(world)} }),`,
    "});",
    "",
  ].join("\n");
}

const AGENT = {
  "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
  "agent/instructions.md": "Help Alice.\n",
};

async function appWithPlatform(source?: string): Promise<string> {
  const { appRoot } = await createAppRoot("eve-platform-selection-", {
    files: source === undefined ? AGENT : { ...AGENT, "agent/platform.ts": source },
  });
  return appRoot;
}

describe("platform selection", () => {
  it("uses eve's built-in platform when the agent has no platform file", async () => {
    const appRoot = await appWithPlatform();

    expect(selectPlatformModule(appRoot)).toBe(
      resolvePackageSourceFilePath("src/platform/vercel/declaration.ts"),
    );
    expect((await loadPlatformBuild(appRoot)).schedules?.kind).toBe("vercel");
  });

  it("uses platform.ts beside agent.ts in a flat project, and names it in its error", async () => {
    const { appRoot } = await createAppRoot("eve-platform-flat-", {
      files: {
        "agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
        "instructions.md": "Help Alice.\n",
        "platform.ts": [
          `import { definePlatform } from ${declarationModule};`,
          "export default definePlatform({",
          ...ALICE_DEPLOYMENT,
          '  build: { schedules: { kind: "alice-flat-schedules" } },',
          "});",
          "",
        ].join("\n"),
      },
    });

    await rm(join(appRoot, "agent"), { recursive: true });

    expect(selectPlatformModule(appRoot)).toBe(join(appRoot, "platform.ts"));
    expect((await loadPlatformBuild(appRoot)).schedules?.kind).toBe("alice-flat-schedules");

    const { appRoot: invalidRoot } = await createAppRoot("eve-platform-flat-invalid-", {
      files: {
        "agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
        "platform.ts": "export default { deployment: () => ({}) };\n",
      },
    });
    await rm(join(invalidRoot, "agent"), { recursive: true });
    await expect(loadPlatformBuild(invalidRoot)).rejects.toThrow(
      'The default export of "platform.ts" is not a platform declaration.',
    );
  });

  it("uses agent/platform.ts and reads its build", async () => {
    const appRoot = await appWithPlatform(
      [
        `import { definePlatform } from ${declarationModule};`,
        "export default definePlatform({",
        "  deployment: () => ({",
        '    environment: () => "production",',
        '    deploymentId: () => "dpl_alice",',
        "    host: () => undefined,",
        "    scope: () => undefined,",
        "  }),",
        '  build: { schedules: { kind: "alice-schedules" } },',
        "});",
        "",
      ].join("\n"),
    );

    expect(selectPlatformModule(appRoot)).toBe(authoredPlatformModule(appRoot));
    expect(await loadPlatformBuild(appRoot)).toEqual({ schedules: { kind: "alice-schedules" } });
  });

  it("stops with a fix when agent/platform.ts exports something else", async () => {
    const appRoot = await appWithPlatform("export default { deployment: () => ({}) };\n");

    await expect(loadPlatformBuild(appRoot)).rejects.toThrow(
      'The default export of "agent/platform.ts" is not a platform declaration. Export the result of definePlatform({ deployment, ... }) from "eve/experimental/platform" as its default export, or delete the file to use eve\'s built-in platform.',
    );
  });

  it("reads the build of the platform's engine without starting it", async () => {
    const appRoot = await appWithPlatform(
      [
        `import { definePlatform } from ${declarationModule};`,
        "export default definePlatform({",
        "  deployment: () => { throw new Error('the build made the deployment'); },",
        "  durable: () => ({",
        "    build: { runs: false, entries: { 'alice-worker': './lib/worker.ts' } },",
        "    start: () => { throw new Error('the build started the engine'); },",
        "  }),",
        "});",
        "",
      ].join("\n"),
    );

    const declaration = await loadPlatformDeclaration(selectPlatformModule(appRoot), appRoot);

    expect(declaration.durable?.().build).toEqual({
      runs: false,
      entries: { "alice-worker": "./lib/worker.ts" },
    });
  });

  it("never calls the platform's context() while it reads the build", async () => {
    const appRoot = await appWithPlatform(
      [
        `import { definePlatform } from ${declarationModule};`,
        "export default definePlatform({",
        "  context: () => { throw new Error('the build called context()'); },",
        "  deployment: () => { throw new Error('the build made the deployment'); },",
        "  build: { outputDirectory: 'dist/worker' },",
        "});",
        "",
      ].join("\n"),
    );

    const build = await loadPlatformBuild(appRoot);

    expect(build.outputDirectory).toBe("dist/worker");
  });

  it("gives the World of the platform's Workflow engine to the compiled agent", async () => {
    const { appRoot } = await createAppRoot("eve-platform-selection-", {
      files: {
        ...AGENT,
        "agent/agent.ts":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
        "agent/platform.ts": workflowPlatform("@workflow/world-postgres"),
      },
    });

    const { manifest } = await compileAgent({ startPath: appRoot });

    expect(manifest.config.experimental?.workflow?.world).toBe("@workflow/world-postgres");
  });

  it("stops when agent.ts and the platform name different Worlds", async () => {
    const { appRoot } = await createAppRoot("eve-platform-selection-", {
      files: {
        ...AGENT,
        "agent/agent.ts":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4", experimental: { workflow: { world: "@workflow/world-local" } } });\n',
        "agent/platform.ts": workflowPlatform("@workflow/world-postgres"),
      },
    });

    await expect(compileAgent({ startPath: appRoot })).rejects.toThrow(
      'agent.ts sets experimental.workflow.world to "@workflow/world-local", and agent/platform.ts gives workflowEngine({ world: "@workflow/world-postgres" }). Set the World in one of the two files.',
    );
  });
});
