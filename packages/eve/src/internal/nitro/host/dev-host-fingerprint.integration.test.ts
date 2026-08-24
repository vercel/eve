import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  createCompiledExternalDependencySemanticHash,
  type CompiledExternalDependencyPlanEntry,
} from "#compiler/external-dependency-plan.js";
import { computeDevelopmentHostFingerprint } from "#internal/nitro/host/dev-host-fingerprint.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import {
  createStubCompiledAgentManifest as createCompiledAgentManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";

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
  readonly channels?: CompiledAgentManifest["channelRoutes"]["effective"];
  readonly externalDependencyContentSha256?: string;
  readonly instrumentationSlot?: string;
  readonly instrumentationSource?: string;
  readonly schedules?: CompiledAgentManifest["schedules"];
  readonly workflowWorld?: "local" | "vercel";
  readonly workflowWorldIdentity?: string;
}

async function createHost(variant: HostVariant = {}): Promise<PreparedDevelopmentApplicationHost> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-host-fingerprint-"));
  temporaryDirectories.push(appRoot);
  const agentRoot = join(appRoot, "agent");
  await mkdir(agentRoot, { recursive: true });

  const instrumentationIdentity = createHash("sha256")
    .update(variant.instrumentationSource ?? "framework-default")
    .digest("hex");
  const instrumentationLogicalPath =
    variant.instrumentationSlot === undefined
      ? "instrumentation.ts"
      : `instrumentation/${variant.instrumentationSlot}.ts`;
  const instrumentationSourceId = `test:${instrumentationLogicalPath}`;
  const experimental: {
    instrumentationProviders?: true;
  } = {};
  if (variant.instrumentationSlot !== undefined) experimental.instrumentationProviders = true;

  const workflowWorld =
    variant.workflowWorldIdentity === undefined
      ? ({
          kind: "native",
          selection: variant.workflowWorld === undefined ? "host-default" : "configured",
          target: variant.workflowWorld ?? "local",
        } as const)
      : ({
          backing: {
            entryPackageId: "root",
            entryPath: join(appRoot, "node_modules", "@acme", "world", "index.js"),
            identitySha256: variant.workflowWorldIdentity,
            mode: "materialized",
            packages: [],
          },
          kind: "host-module",
          packageName: "@acme/world",
          protocol: {
            declaredPackageName: "@workflow/core",
            declaredRange: "^5.0.0-beta.43",
            expectedVersion: "5.0.0-beta.43",
          },
          selection: "configured",
        } as const);
  let manifest = createCompiledAgentManifest({
    agentRoot,
    appRoot,
    bindings: [
      TEST_COMPILED_AGENT_CONFIG_BINDING,
      ...(variant.channels ?? []).map((channel) => ({
        logicalPath: channel.logicalPath,
        sourceId: channel.sourceId,
      })),
      ...(variant.schedules ?? [])
        .filter((schedule) => schedule.sourceKind === "module" && schedule.hasRun)
        .map((schedule) => ({ logicalPath: schedule.logicalPath, sourceId: schedule.sourceId })),
      {
        binding: {
          backing: {
            kind: "programmatic",
            moduleId: instrumentationLogicalPath,
            registryId:
              variant.instrumentationSlot === undefined
                ? "test-local-tracing"
                : "test-instrumentation",
            revision: instrumentationIdentity,
          },
          owner:
            variant.instrumentationSlot === undefined
              ? { feature: "test-local-tracing", kind: "framework" }
              : { kind: "application" },
        },
        logicalPath: instrumentationLogicalPath,
        sourceId: instrumentationSourceId,
      },
    ],
    channelRoutes: { effective: variant.channels ?? [], preflight: [], shadowed: [] },
    config: {
      model: { id: "openai/gpt-5-mini", routing: { kind: "gateway", target: "openai" } },
      name: "fingerprint-host",
      experimental,
      source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
    },
    instrumentation:
      variant.instrumentationSlot === undefined
        ? {
            entry: {
              activation: "development",
              implementation: "local-tracing",
              source: {
                logicalPath: instrumentationLogicalPath,
                sourceId: instrumentationSourceId,
                sourceKind: "module",
              },
            },
            kind: "file",
          }
        : {
            entries: [
              {
                activation: "always",
                implementation: "provider",
                slot: variant.instrumentationSlot,
                source: {
                  logicalPath: instrumentationLogicalPath,
                  sourceId: instrumentationSourceId,
                  sourceKind: "module",
                },
              },
            ],
            kind: "providers",
          },
    schedules: variant.schedules ?? [],
    workflowWorld:
      workflowWorld.kind === "native"
        ? workflowWorld
        : { kind: "native", selection: "host-default", target: "local" },
  });
  if (workflowWorld.kind === "host-module") {
    manifest = { ...manifest, workflowWorld } as CompiledAgentManifest;
  }
  if (variant.externalDependencyContentSha256 !== undefined) {
    const entry: Omit<CompiledExternalDependencyPlanEntry, "semanticSha256"> = {
      conditions: ["node", "import", "default"],
      id: "host-runtime",
      packageName: "host-runtime",
      packages: [
        {
          contentSha256: variant.externalDependencyContentSha256,
          dependencies: [],
          id: "0",
          packageName: "host-runtime",
          resolvedPackageRoot: "/virtual/host-runtime",
        },
      ],
      rootPackageId: "0",
      scopes: [
        {
          kind: "application",
          nodeId: "__root__",
          sourceRoot: appRoot,
        },
      ],
    };
    manifest = {
      ...manifest,
      externalDependencyPlan: {
        entries: [
          {
            ...entry,
            semanticSha256: createCompiledExternalDependencySemanticHash(entry),
          },
        ],
      },
    };
  }

  return {
    appRoot,
    compiledArtifacts: {
      bootstrapPath: join(appRoot, "bootstrap.mjs"),
      instrumentationPluginPath: join(appRoot, "instrumentation.mjs"),
      workflowWorldPluginPath: join(appRoot, "workflow-world.mjs"),
    },
    compileResult: { manifest } as PreparedDevelopmentApplicationHost["compileResult"],
  } as PreparedDevelopmentApplicationHost;
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

  it("treats external package closure content as structural", async () => {
    const first = await computeDevelopmentHostFingerprint(
      await createHost({ externalDependencyContentSha256: "a".repeat(64) }),
    );
    const changed = await computeDevelopmentHostFingerprint(
      await createHost({ externalDependencyContentSha256: "b".repeat(64) }),
    );

    expect(changed).not.toBe(first);
  });

  it("treats channel route topology as structural", async () => {
    const base = await computeDevelopmentHostFingerprint(await createHost());
    const withRoute = await computeDevelopmentHostFingerprint(
      await createHost({
        channels: [
          {
            kind: "channel",
            logicalPath: "channels/smoke.ts",
            method: "GET",
            name: "smoke",
            sourceId: "channels/smoke.ts",
            sourceKind: "module",
            urlPath: "/smoke",
          },
        ] as CompiledAgentManifest["channelRoutes"]["effective"],
      }),
    );

    expect(withRoute).not.toBe(base);
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

  it("treats same-specifier custom world content identity as structural", async () => {
    const first = await computeDevelopmentHostFingerprint(
      await createHost({ workflowWorldIdentity: "1".repeat(64) }),
    );
    const changed = await computeDevelopmentHostFingerprint(
      await createHost({ workflowWorldIdentity: "2".repeat(64) }),
    );

    expect(changed).not.toBe(first);
  });

  it("leaves schedule definitions runtime-only", async () => {
    const base = await computeDevelopmentHostFingerprint(await createHost());
    const withSchedule = await computeDevelopmentHostFingerprint(
      await createHost({
        schedules: [
          {
            cron: "0 0 * * 0",
            hasRun: false,
            logicalPath: "schedules/heartbeat.md",
            markdown: "Report the weather.",
            name: "heartbeat",
            sourceId: "schedules/heartbeat.md",
            sourceKind: "markdown",
          },
        ],
      }),
    );

    expect(withSchedule).toBe(base);
  });
});
