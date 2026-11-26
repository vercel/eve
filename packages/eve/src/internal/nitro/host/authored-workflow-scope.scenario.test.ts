import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createApplicationBuildWorkspace,
  removeApplicationBuildWorkspace,
} from "#internal/application/build-workspace.js";
import { resolvePackageRoot } from "#internal/application/package.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { WorkflowBundleBuilder } from "#internal/workflow-bundle/builder.js";
import { buildApplication } from "./build-application.js";
import { buildExtensionPackage, tryReadExtensionBuildConfig } from "./build-extension.js";
import { startProductionServer } from "./start-production-server.js";
import { prepareProductionApplicationHost } from "./prepare-application-host.js";

const ALIAS_MARKER = "workflow-alias-resolved";
const WORKFLOW_ASSET_MARKER = "workflow-raw-asset-embedded";
const STEP_ASSET_MARKER = "step-raw-asset-embedded";

function readWorkflowCode(buildDir: string): Promise<string> {
  return readFile(join(buildDir, "workflows.code.txt"), "utf8");
}

async function readServerSources(outputDir: string): Promise<string> {
  const serverFiles = await readdir(join(outputDir, "server"), { recursive: true });
  const sources = await Promise.all(
    serverFiles
      .filter((file) => file.endsWith(".mjs"))
      .map((file) => readFile(join(outputDir, "server", file), "utf8")),
  );
  return sources.join("\n");
}

describe("authored workflow scope", () => {
  const scenarioApp = useScenarioApp();

  it.each(["tsconfig.json", "jsconfig.json"])(
    "resolves workflow aliases from the application's %s",
    async (configFile) => {
      const app = await scenarioApp({
        name: "workflow-app-alias",
        installDependencies: true,
        files: {
          [configFile]: JSON.stringify({
            compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } },
          }),
          "agent/agent.ts":
            'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
          "agent/instructions.md": "Call the probe tool.",
          "agent/tools/probe.ts":
            'import { defineWorkflowTool } from "eve/tools"; import { run } from "@/lib/run"; export default defineWorkflowTool({ description: "Probe", inputSchema: {}, execute: run });',
          "agent/channels/probe.ts": `import { defineChannel, GET } from "eve/channels";
import { start, getRun } from "eve/workflow/api";
import { run } from "@/lib/run";
export default defineChannel({ routes: [GET("/workflow-api", async () => {
  const started = await start(run);
  return Response.json(await getRun(started.runId).returnValue);
})] });`,
          "lib/run.ts": `import { createHook } from "eve/workflow";
import { describe } from "@/lib/describe";
import { deliver } from "./step";
export async function run() {
  "use workflow";
  using hook = createHook<string>({ token: "workflow-api-probe" });
  const returnedUndefined = await deliver();
  return { marker: describe(), returnedUndefined, payload: await hook };
}`,
          "lib/step.ts": `import { resumeHook } from "eve/workflow/api";
export async function deliver() {
  "use step";
  return (await resumeHook("workflow-api-probe", "approved")) === undefined;
}`,
          "lib/describe.ts": `export function describe() { return ${JSON.stringify(ALIAS_MARKER)}; }`,
        },
      });
      const appRoot = await realpath(app.appRoot);
      const outputDir = await buildApplication(appRoot, { skipSandboxPrewarm: false });
      const serverSource = await readServerSources(outputDir);
      expect(serverSource).toContain(ALIAS_MARKER);
      expect(serverSource).not.toContain('require("@/lib/describe")');
      const server = await startProductionServer(appRoot, { port: 0, host: "127.0.0.1" });
      try {
        expect((await fetch(new URL("/eve/v1/health", server.url))).status).toBe(200);
        const response = await fetch(new URL("/workflow-api", server.url), {
          signal: AbortSignal.timeout(30_000),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          marker: ALIAS_MARKER,
          returnedUndefined: true,
          payload: "approved",
        });
      } finally {
        await server.close();
      }
    },
  );

  it("excludes host workflows while retaining reachable workflow step helpers", async () => {
    const app = await scenarioApp({
      name: "workflow-agent-scope",
      installDependencies: true,
      files: {
        "agent/agent.ts":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
        "agent/instructions.md": "Call the probe tool.",
        "agent/tools/probe.ts":
          'import { defineWorkflowTool } from "eve/tools"; import { run } from "../../lib/run"; export default defineWorkflowTool({ description: "Probe", inputSchema: {}, execute: run });',
        "lib/run.ts":
          'import { readMarker } from "./step"; export async function run() { "use workflow"; return readMarker(); }',
        "lib/step.ts":
          'import { hostname } from "node:os"; export async function readMarker() { "use step"; return hostname(); }',
        "components/layout.js":
          "export default function Layout() { return <div>Host application</div>; }",
        "workflows/host.ts":
          'import { readFileSync } from "node:fs"; export async function unrelatedHostWorkflow() { "use workflow"; return readFileSync("host.txt", "utf8"); }',
      },
    });
    const appRoot = await realpath(app.appRoot);
    const workspace = await createApplicationBuildWorkspace(appRoot);
    try {
      const host = await prepareProductionApplicationHost(workspace);
      const builder = new WorkflowBundleBuilder({
        agentName: host.compileResult.manifest.config.name,
        appRoot,
        compiledArtifactsBootstrapPath: host.compiledArtifacts.bootstrapPath,
        outDir: workspace.workflow.buildDir,
        rootDir: resolvePackageRoot(),
        authoredWorkflowModules: host.compiledArtifacts.authoredWorkflowModules,
      });
      await builder.build();
      const steps = await readFile(join(workspace.workflow.buildDir, "steps.mjs"), "utf8");
      const code = await readWorkflowCode(workspace.workflow.buildDir);
      expect(steps).toContain("lib/step.ts");
      expect(code).toContain("workflow//./lib/run//run");
      expect(code).toContain("step//./lib/step//readMarker");
      expect(code).not.toContain("unrelatedHostWorkflow");
      expect(steps).not.toContain("workflows/host.ts");
    } finally {
      await removeApplicationBuildWorkspace(workspace);
    }
  });

  it.each([
    { layout: "a standalone app", member: "", toPackageRoot: "../.." },
    { layout: "a workspace member", member: "agents/probe/", toPackageRoot: "../../../.." },
  ])("embeds ?raw assets imported by workflow and step modules in $layout", async (input) => {
    const app = await scenarioApp({
      name: "workflow-raw-assets",
      installDependencies: true,
      files: {
        [`${input.member}agent/agent.ts`]:
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
        [`${input.member}agent/instructions.md`]: "Call the probe tool.",
        [`${input.member}agent/tools/probe.ts`]: `import { defineWorkflowTool } from "eve/tools"; import { run } from "${input.toPackageRoot}/lib/run"; export default defineWorkflowTool({ description: "Probe", inputSchema: {}, execute: run });`,
        "lib/run.ts":
          'import header from "../prompts/workflow.txt?raw"; import { readPrompt } from "./step"; export async function run() { "use workflow"; return header + (await readPrompt()); }',
        "lib/step.ts":
          'import prompt from "../prompts/step.md?raw"; export async function readPrompt() { "use step"; return prompt; }',
        "prompts/workflow.txt": WORKFLOW_ASSET_MARKER,
        "prompts/step.md": STEP_ASSET_MARKER,
      },
    });
    const appRoot = join(await realpath(app.appRoot), input.member);
    const outputDir = await buildApplication(appRoot, { skipSandboxPrewarm: false });
    const serverSource = await readServerSources(outputDir);
    expect(serverSource).toContain(STEP_ASSET_MARKER);
    expect(serverSource).toContain(WORKFLOW_ASSET_MARKER);
  });

  it("embeds ?raw assets from node_modules imported by workflow and step modules", async () => {
    const app = await scenarioApp({
      name: "workflow-dependency-raw-assets",
      installDependencies: true,
      dependencies: { "raw-assets": "file:./vendor/raw-assets" },
      files: {
        "agent/agent.ts":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
        "agent/instructions.md": "Call the probe tool.",
        "agent/tools/probe.ts":
          'import { defineWorkflowTool } from "eve/tools"; import { run } from "../../lib/run"; export default defineWorkflowTool({ description: "Probe", inputSchema: {}, execute: run });',
        "lib/run.ts":
          'import header from "../node_modules/raw-assets/workflow.txt?raw"; import { readPrompt } from "./step"; export async function run() { "use workflow"; return header + (await readPrompt()); }',
        "lib/step.ts":
          'import prompt from "../node_modules/raw-assets/step.md?raw"; export async function readPrompt() { "use step"; return prompt; }',
        "vendor/raw-assets/package.json": JSON.stringify({ name: "raw-assets", version: "1.0.0" }),
        "vendor/raw-assets/workflow.txt": WORKFLOW_ASSET_MARKER,
        "vendor/raw-assets/step.md": STEP_ASSET_MARKER,
      },
    });
    const outputDir = await buildApplication(await realpath(app.appRoot), {
      skipSandboxPrewarm: false,
    });
    const serverSource = await readServerSources(outputDir);
    expect(serverSource).toContain(STEP_ASSET_MARKER);
    expect(serverSource).toContain(WORKFLOW_ASSET_MARKER);
  });

  it("runs mount-scoped workflow tools and steps from built extensions across duplicate mounts", async () => {
    const app = await scenarioApp({
      name: "workflow-extension-mounts",
      installDependencies: true,
      files: {
        "agent/agent.ts":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });',
        "agent/instructions.md": "Use the mounted extension tools.",
        "agent/extensions/alpha.ts":
          'import video from "@acme/video";\nexport default video({ apiKey: "secret-alpha", tag: "alpha" });\n',
        "agent/extensions/beta.ts":
          'import video from "@acme/video";\nexport default video({ apiKey: "secret-beta", tag: "beta" });\n',
        "agent/extensions/env_only.ts":
          'import envStep from "@acme/env-step";\nexport default envStep({ apiKey: process.env.EVE_TEST_EXT_KEY ?? "fallback-key" });\n',
        "vendor/video/package.json": JSON.stringify({
          name: "@acme/video",
          version: "1.0.0",
          type: "module",
          eve: { extension: { source: "extension", dist: "dist/extension" } },
          peerDependencies: { eve: "*" },
        }),
        "vendor/video/tsconfig.json": JSON.stringify({
          compilerOptions: {
            module: "esnext",
            moduleResolution: "bundler",
            skipLibCheck: true,
            types: [],
          },
          include: ["extension/**/*.ts"],
        }),
        "vendor/video/extension/node.d.ts": `declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: "hex"): string };
  };
}
`,
        "vendor/video/extension/extension.ts": `import { defineExtension } from "eve/extension";
interface VideoConfig {
  readonly apiKey: string;
  readonly tag: string;
}
const config: {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: VideoConfig; readonly output: VideoConfig };
    readonly validate: (
      value: unknown,
    ) => { readonly value: VideoConfig } | { readonly issues: readonly { readonly message: string }[] };
  };
} = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => {
      const record = (value ?? {}) as Record<string, unknown>;
      if (typeof record.apiKey !== "string" || typeof record.tag !== "string") {
        return { issues: [{ message: "apiKey and tag are required" }] };
      }
      return { value: { apiKey: record.apiKey, tag: record.tag } };
    },
  },
};
export default defineExtension({ config });
`,
        "vendor/video/extension/lib/jobs.ts": `import { createHash } from "node:crypto";
import extension from "../extension";

export async function renderClip(prompt: string): Promise<{ stepTag: string; hash: string }> {
  "use step";
  const { apiKey, tag } = extension.config;
  return {
    stepTag: tag,
    hash: createHash("sha256").update(\`\${apiKey}:\${prompt}\`).digest("hex").slice(0, 12),
  };
}
`,
        "vendor/video/extension/tools/generate.ts": `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "eve/workflow";
import extension from "../extension";
import { renderClip } from "../lib/jobs";

export default defineWorkflowTool({
  description: "Generate clip",
  inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
  async task({ prompt }: { prompt: string }) {
    "use workflow";
    await sleep("1ms");
    const rendered = await renderClip(prompt);
    return { workflowTag: extension.config.tag, ...rendered };
  },
});
`,
        "vendor/video/extension/tools/confirm.ts": `import { defineWorkflowTool } from "eve/tools";
import { renderClip } from "../lib/jobs";

export default defineWorkflowTool({
  description: "Confirm clip",
  inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
  async execute({ prompt }: { prompt: string }) {
    "use workflow";
    return await renderClip(prompt);
  },
});
`,
        "vendor/video/extension/tools/session.ts": `import { defineWorkflowTool } from "eve/tools";
import { renderClip } from "../lib/jobs";

export default defineWorkflowTool({
  description: "Serve clips",
  inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
  async serve(receive, ctx) {
    "use workflow";
    const call = await receive();
    const { prompt } = call.input as { prompt: string };
    ctx.reply(await renderClip(prompt));
  },
});
`,
        "vendor/video/extension/subagents/worker/agent.ts": `import { defineAgent } from "eve";
export default defineAgent({ description: "Video worker", model: "openai/gpt-5.4" });
`,
        "vendor/video/extension/subagents/worker/tools/job.ts": `import { defineWorkflowTool } from "eve/tools";
import { renderClip } from "../../../lib/jobs";

export default defineWorkflowTool({
  description: "Run worker job",
  inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
  async execute({ prompt }: { prompt: string }) {
    "use workflow";
    return await renderClip(prompt);
  },
});
`,
        "vendor/video/extension/channels/probe.ts": `import { defineChannel, GET } from "eve/channels";
import { getRun, start } from "eve/workflow/api";
import extension from "../extension";
import confirm from "../tools/confirm";
import generate from "../tools/generate";
import session from "../tools/session";
import workerJob from "../subagents/worker/tools/job";

export default defineChannel({
  routes: [
    GET(\`/\${extension.config.tag}/probe\`, async () => {
      const [taskRun, executeRun, subagentRun] = await Promise.all([
        start(generate.task as never, [{ prompt: "clip" }] as never),
        start(confirm.execute as never, [{ prompt: "confirm" }] as never),
        start(workerJob.execute as never, [{ prompt: "worker" }] as never),
      ]);
      return Response.json({
        serveWorkflowId: (session.serve as { workflowId?: string }).workflowId,
        task: await getRun(taskRun.runId).returnValue,
        execute: await getRun(executeRun.runId).returnValue,
        subagent: await getRun(subagentRun.runId).returnValue,
      });
    }),
  ],
});
`,
        "vendor/env-step/package.json": JSON.stringify({
          name: "@acme/env-step",
          version: "1.0.0",
          type: "module",
          eve: { extension: { source: "extension", dist: "dist/extension" } },
          peerDependencies: { eve: "*" },
        }),
        "vendor/env-step/tsconfig.json": JSON.stringify({
          compilerOptions: {
            module: "esnext",
            moduleResolution: "bundler",
            skipLibCheck: true,
            types: [],
          },
          include: ["extension/**/*.ts"],
        }),
        "vendor/env-step/extension/extension.ts": `import { defineExtension } from "eve/extension";
interface EnvConfig {
  readonly apiKey: string;
}
const config: {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: EnvConfig; readonly output: EnvConfig };
    readonly validate: (
      value: unknown,
    ) => { readonly value: EnvConfig } | { readonly issues: readonly { readonly message: string }[] };
  };
} = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => {
      const record = (value ?? {}) as Record<string, unknown>;
      if (typeof record.apiKey !== "string") {
        return { issues: [{ message: "apiKey is required" }] };
      }
      return { value: { apiKey: record.apiKey } };
    },
  },
};
export default defineExtension({ config });
`,
        "vendor/env-step/extension/tools/check.ts": `import { defineWorkflowTool } from "eve/tools";
import extension from "../extension";

export default defineWorkflowTool({
  description: "Check env-backed step config",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    "use workflow";
    return await readKey();
  },
});

async function readKey(): Promise<{ key: string }> {
  "use step";
  return { key: extension.config.apiKey };
}
`,
        "vendor/env-step/extension/channels/probe.ts": `import { defineChannel, GET } from "eve/channels";
import { getRun, start } from "eve/workflow/api";
import check from "../tools/check";

export default defineChannel({
  routes: [
    GET("/env-step/probe", async () => {
      const run = await start(check.execute as never);
      return Response.json(await getRun(run.runId).returnValue);
    }),
  ],
});
`,
      },
    });
    const appRoot = await realpath(app.appRoot);
    const evePackageRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
    const scopeDir = join(appRoot, "node_modules", "@acme");
    await mkdir(scopeDir, { recursive: true });
    for (const [dirName, pkgName] of [
      ["video", "video"],
      ["env-step", "env-step"],
    ] as const) {
      const extRoot = join(appRoot, "vendor", dirName);
      await mkdir(join(extRoot, "node_modules"), { recursive: true });
      await symlink(evePackageRoot, join(extRoot, "node_modules", "eve"), "dir");
      const extConfig = await tryReadExtensionBuildConfig(extRoot);
      await buildExtensionPackage(extRoot, extConfig!);
      await symlink(extRoot, join(scopeDir, pkgName), "dir");
    }

    const previousKey = process.env.EVE_TEST_EXT_KEY;
    process.env.EVE_TEST_EXT_KEY = "runtime-secret";
    try {
      await buildApplication(appRoot, { skipSandboxPrewarm: false });
      const server = await startProductionServer(appRoot, { port: 0, host: "127.0.0.1" });
      try {
        expect((await fetch(new URL("/eve/v1/health", server.url))).status).toBe(200);
        const expectedHash = (apiKey: string, prompt: string) =>
          createHash("sha256").update(`${apiKey}:${prompt}`).digest("hex").slice(0, 12);

        const [alphaRes, betaRes, envRes] = await Promise.all([
          fetch(new URL("/alpha/probe", server.url), { signal: AbortSignal.timeout(30_000) }),
          fetch(new URL("/beta/probe", server.url), { signal: AbortSignal.timeout(30_000) }),
          fetch(new URL("/env-step/probe", server.url), { signal: AbortSignal.timeout(30_000) }),
        ]);
        expect(alphaRes.status).toBe(200);
        expect(betaRes.status).toBe(200);
        expect(envRes.status).toBe(200);

        expect(await alphaRes.json()).toEqual({
          serveWorkflowId: "workflow//@eve-mount/[extensions/alpha]/tools/session//serve",
          task: {
            workflowTag: "alpha",
            stepTag: "alpha",
            hash: expectedHash("secret-alpha", "clip"),
          },
          execute: { stepTag: "alpha", hash: expectedHash("secret-alpha", "confirm") },
          subagent: { stepTag: "alpha", hash: expectedHash("secret-alpha", "worker") },
        });
        expect(await betaRes.json()).toEqual({
          serveWorkflowId: "workflow//@eve-mount/[extensions/beta]/tools/session//serve",
          task: {
            workflowTag: "beta",
            stepTag: "beta",
            hash: expectedHash("secret-beta", "clip"),
          },
          execute: { stepTag: "beta", hash: expectedHash("secret-beta", "confirm") },
          subagent: { stepTag: "beta", hash: expectedHash("secret-beta", "worker") },
        });
        expect(await envRes.json()).toEqual({ key: "runtime-secret" });
      } finally {
        await server.close();
      }
    } finally {
      if (previousKey === undefined) {
        delete process.env.EVE_TEST_EXT_KEY;
      } else {
        process.env.EVE_TEST_EXT_KEY = previousKey;
      }
    }
  });
});
