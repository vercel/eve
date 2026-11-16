import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CompiledAgentManifest, CompiledExtensionMount } from "#compiler/manifest.js";
import { compileFromMemory } from "#internal/testing/compile-from-memory.js";
import { computeDevelopmentHostFingerprint } from "#internal/nitro/host/dev-host-fingerprint.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import { defineChannel, GET } from "#public/definitions/channel.js";
import { defineSchedule } from "#public/definitions/schedule.js";
import { defineTool } from "#tools/definition.js";
import { defineWorkflowTool } from "#tools/workflow-definition.js";
import { attachWorkflowProgramOptions } from "#tools/workflow-program-input.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.EVE_HOST_FINGERPRINT_TEST;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (dir) => await rm(dir, { force: true, recursive: true })),
  );
});

interface HostVariant {
  readonly channel?: { readonly path: string };
  readonly connection?: { readonly events: boolean };
  readonly extensionSpecifier?: string;
  readonly extensionConfig?: { readonly region: string };
  readonly instrumentationSlot?: string;
  readonly instrumentationSource?: string;
  /** Where the app's package.json lives: its own root, or an enclosing workspace. */
  readonly packageJson?: "own" | "enclosing";
  readonly schedule?: { readonly cron: string; readonly content: string };
  readonly tool?: "ordinary" | "workflow" | "workflow-program";
  readonly tsconfig?: boolean;
  readonly workflowSourceFingerprint?: string;
  readonly workflowWorld?: "local" | "vercel";
}

async function createHost(variant: HostVariant = {}): Promise<PreparedDevelopmentApplicationHost> {
  const root = await mkdtemp(join(tmpdir(), "eve-host-fingerprint-"));
  temporaryDirectories.push(root);
  const appRoot = variant.packageJson === "enclosing" ? join(root, "app") : root;
  const agentRoot = join(appRoot, "agent");
  await mkdir(agentRoot, { recursive: true });
  if (variant.packageJson !== undefined) {
    await writeFile(join(root, "package.json"), '{ "name": "fingerprint-host" }\n');
  }
  if (variant.tsconfig === true) {
    await writeFile(join(appRoot, "tsconfig.json"), "{}\n");
  }

  let instrumentationSourcePath: string | undefined;
  if (variant.instrumentationSource !== undefined) {
    instrumentationSourcePath = join(appRoot, "instrumentation-source.mjs");
    await writeFile(instrumentationSourcePath, variant.instrumentationSource);
  }

  const modules = [
    ...(variant.channel === undefined
      ? []
      : [
          {
            logicalPath: "channels/smoke.ts",
            loadNamespace: async () => ({
              default: defineChannel({
                routes: [GET(variant.channel!.path, async () => new Response("ok"))],
              }),
            }),
          },
        ]),
    ...(variant.schedule === undefined
      ? []
      : [
          {
            logicalPath: "schedules/heartbeat.ts",
            loadNamespace: async () => ({
              default: defineSchedule(variant.schedule!),
            }),
          },
        ]),
    ...(variant.tool === undefined
      ? []
      : [
          {
            logicalPath: "tools/run.ts",
            loadNamespace: async () => {
              if (variant.tool === "ordinary") {
                return {
                  default: defineTool({
                    description: "Run a tool.",
                    execute: async () => null,
                    inputSchema: {},
                  }),
                };
              }
              const execute = Object.assign(async () => null, {
                workflowId: "workflow//agent/tools/run//execute",
              });
              const definition = defineWorkflowTool({
                description: "Run a workflow.",
                execute,
                inputSchema: {},
              });
              return {
                default:
                  variant.tool === "workflow-program"
                    ? attachWorkflowProgramOptions(definition, {
                        maxSubagents: 4,
                      })
                    : definition,
              };
            },
          },
        ]),
  ];
  const { manifest } = await compileFromMemory({
    agentRoot,
    appRoot,
    agent: {
      model: "openai/gpt-5.4",
      ...(variant.workflowWorld === undefined
        ? {}
        : { experimental: { workflow: { world: variant.workflowWorld } } }),
    },
    model: "openai/gpt-5.4",
    modules,
    name: "fingerprint-host",
  });
  if (variant.connection !== undefined) {
    manifest.connections = [
      {
        connectionName: "issues",
        ...(variant.connection.events && { experimental_events: true }),
      },
    ] as CompiledAgentManifest["connections"];
  }
  if (variant.extensionSpecifier !== undefined) {
    manifest.extensionMounts = [
      extensionMount(appRoot, variant.extensionSpecifier, variant.extensionConfig),
    ];
  }

  return {
    appRoot,
    compiledArtifacts: {
      bootstrapPath: join(appRoot, "bootstrap.mjs"),
      ...(instrumentationSourcePath === undefined
        ? {}
        : {
            instrumentationLayout: {
              kind: "directory",
              slots: [variant.instrumentationSlot ?? "provider"],
            } as const,
            instrumentationSourcePaths: [instrumentationSourcePath],
          }),
      workflowWorldPluginPath: join(appRoot, "workflow-world.mjs"),
    },
    compileResult: {
      manifest,
      paths: { compileDirectoryPath: join(appRoot, ".eve", "compile") },
    } as PreparedDevelopmentApplicationHost["compileResult"],
    scheduleRegistrations: [],
    schedules: [],
    workflowBuildDir: join(appRoot, ".eve", "workflow"),
    workspace: {
      nitroBuildDir: join(appRoot, ".eve", "nitro"),
      nitroOutputDir: join(appRoot, ".eve", "output"),
    } as PreparedDevelopmentApplicationHost["workspace"],
    workspaceExtensions: [],
    generation: {
      fingerprint: "generation",
      ...(variant.workflowSourceFingerprint === undefined
        ? {}
        : { workflowSourceFingerprint: variant.workflowSourceFingerprint }),
    } as PreparedDevelopmentApplicationHost["generation"],
  } as PreparedDevelopmentApplicationHost;
}

function extensionMount(
  appRoot: string,
  specifier: string,
  config?: { readonly region: string },
): CompiledExtensionMount {
  const packageRoot = join(appRoot, "node_modules", "layout-extension");
  return {
    ...(config && {
      programmaticImport: {
        config,
        entryPath: join(packageRoot, "dist", "index.mjs"),
        specifier,
      },
    }),
    externalDependencies: [],
    mountId: "extensions/layout",
    mountLogicalPath: "extensions/layout.ts",
    mountSourceId: "extensions/layout.ts",
    mountSourcePath: join(appRoot, "agent", "extensions", "layout.ts"),
    namespace: "layout",
    packageName: "layout-extension",
    sourceRoot: join(packageRoot, "dist", "extension"),
    specifier,
  };
}

describe("computeDevelopmentHostFingerprint", () => {
  it("is stable for equivalent hosts in different app roots", async () => {
    const first = await computeDevelopmentHostFingerprint(await createHost());
    const second = await computeDevelopmentHostFingerprint(await createHost());

    expect(first).toBe(second);
  });

  it("treats instrumentation content as structural", async () => {
    const base = await computeDevelopmentHostFingerprint(
      await createHost({ instrumentationSource: 'export default { marker: "one" };\n' }),
    );
    const changed = await computeDevelopmentHostFingerprint(
      await createHost({ instrumentationSource: 'export default { marker: "two" };\n' }),
    );

    expect(changed).not.toBe(base);
  });

  it("treats provider slot names as structural", async () => {
    const source = "export default {}\n";
    const first = await computeDevelopmentHostFingerprint(
      await createHost({ instrumentationSlot: "a", instrumentationSource: source }),
    );
    const renamed = await computeDevelopmentHostFingerprint(
      await createHost({ instrumentationSlot: "b", instrumentationSource: source }),
    );

    expect(renamed).not.toBe(first);
  });

  it("treats channel route topology as structural", async () => {
    const base = await computeDevelopmentHostFingerprint(await createHost());
    const withRoute = await computeDevelopmentHostFingerprint(
      await createHost({
        channel: { path: "/smoke" },
      }),
    );

    expect(withRoute).not.toBe(base);
  });

  it("treats connection event receivers as structural", async () => {
    const withoutEvents = await computeDevelopmentHostFingerprint(
      await createHost({ connection: { events: false } }),
    );
    const withEvents = await computeDevelopmentHostFingerprint(
      await createHost({ connection: { events: true } }),
    );

    expect(withEvents).not.toBe(withoutEvents);
  });

  it("treats the specifier an extension is mounted from as structural", async () => {
    const host = await createHost({ extensionSpecifier: "layout-extension" });
    const root = await computeDevelopmentHostFingerprint(host);
    host.compileResult.manifest.extensionMounts = [
      extensionMount(host.appRoot, "layout-extension/tools"),
    ];
    const subpath = await computeDevelopmentHostFingerprint(host);

    expect(subpath).not.toBe(root);
  });

  it("is stable for the same extension mount installed in different app roots", async () => {
    const first = await computeDevelopmentHostFingerprint(
      await createHost({ extensionSpecifier: "layout-extension" }),
    );
    const second = await computeDevelopmentHostFingerprint(
      await createHost({ extensionSpecifier: "layout-extension" }),
    );

    expect(first).toBe(second);
  });

  it("treats the app's tsconfig as structural", async () => {
    const plain = await computeDevelopmentHostFingerprint(await createHost());
    const first = await computeDevelopmentHostFingerprint(await createHost({ tsconfig: true }));
    const second = await computeDevelopmentHostFingerprint(await createHost({ tsconfig: true }));

    expect(first).not.toBe(plain);
    expect(second).toBe(first);
  });

  it("treats the package root authored imports stay inside as structural", async () => {
    const own = await computeDevelopmentHostFingerprint(await createHost({ packageJson: "own" }));
    const otherRoot = await computeDevelopmentHostFingerprint(
      await createHost({ packageJson: "own" }),
    );
    const enclosing = await computeDevelopmentHostFingerprint(
      await createHost({ packageJson: "enclosing" }),
    );

    expect(otherRoot).toBe(own);
    expect(enclosing).not.toBe(own);
  });

  it("leaves a programmatic extension mount's config runtime-only", async () => {
    const host = await createHost({
      extensionConfig: { region: "us" },
      extensionSpecifier: "layout-extension",
    });
    const before = await computeDevelopmentHostFingerprint(host);
    host.compileResult.manifest.extensionMounts = [
      extensionMount(host.appRoot, "layout-extension", { region: "eu" }),
    ];

    expect(await computeDevelopmentHostFingerprint(host)).toBe(before);
  });

  it("treats configured environment values as structural", async () => {
    const host = await createHost();
    await writeFile(join(host.appRoot, ".env"), "EVE_HOST_FINGERPRINT_TEST=one\n");
    process.env.EVE_HOST_FINGERPRINT_TEST = "one";
    const base = await computeDevelopmentHostFingerprint(host);

    process.env.EVE_HOST_FINGERPRINT_TEST = "two";
    const changed = await computeDevelopmentHostFingerprint(host);

    expect(changed).not.toBe(base);
  });

  it("treats the workflow world selection as structural", async () => {
    const local = await computeDevelopmentHostFingerprint(
      await createHost({ workflowWorld: "local" }),
    );
    const vercel = await computeDevelopmentHostFingerprint(
      await createHost({ workflowWorld: "vercel" }),
    );

    expect(vercel).not.toBe(local);
  });

  it("treats authored workflow sources as structural", async () => {
    const base = await computeDevelopmentHostFingerprint(await createHost());
    const withWorkflows = await computeDevelopmentHostFingerprint(
      await createHost({ workflowSourceFingerprint: "a" }),
    );
    const edited = await computeDevelopmentHostFingerprint(
      await createHost({ workflowSourceFingerprint: "b" }),
    );

    expect(withWorkflows).not.toBe(base);
    expect(edited).not.toBe(withWorkflows);
  });

  it("treats only generated-program tool availability as structural", async () => {
    const base = await computeDevelopmentHostFingerprint(await createHost());
    const ordinary = await computeDevelopmentHostFingerprint(
      await createHost({ tool: "ordinary" }),
    );
    const workflow = await computeDevelopmentHostFingerprint(
      await createHost({ tool: "workflow" }),
    );
    const workflowProgram = await computeDevelopmentHostFingerprint(
      await createHost({ tool: "workflow-program" }),
    );

    expect(ordinary).toBe(base);
    expect(workflow).toBe(base);
    expect(workflowProgram).not.toBe(base);
  });

  it("leaves schedule definitions runtime-only", async () => {
    const base = await computeDevelopmentHostFingerprint(await createHost());
    const withSchedule = await computeDevelopmentHostFingerprint(
      await createHost({
        schedule: { cron: "0 0 * * 0", content: "Report the weather." },
      }),
    );

    expect(withSchedule).toBe(base);
  });
});
