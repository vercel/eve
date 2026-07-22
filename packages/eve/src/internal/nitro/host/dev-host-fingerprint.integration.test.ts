import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCompiledAgentManifest, type CompiledAgentManifest } from "#compiler/manifest.js";
import { computeDevelopmentHostFingerprint } from "#internal/nitro/host/dev-host-fingerprint.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";

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
  readonly channels?: CompiledAgentManifest["channels"];
  readonly instrumentationSource?: string;
  readonly schedules?: CompiledAgentManifest["schedules"];
  readonly workflowWorld?: "local" | "vercel";
}

async function createHost(variant: HostVariant = {}): Promise<PreparedDevelopmentApplicationHost> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-host-fingerprint-"));
  temporaryDirectories.push(appRoot);
  const agentRoot = join(appRoot, "agent");
  await mkdir(agentRoot, { recursive: true });

  let instrumentationSourcePath: string | undefined;
  if (variant.instrumentationSource !== undefined) {
    instrumentationSourcePath = join(appRoot, "instrumentation-source.mjs");
    await writeFile(instrumentationSourcePath, variant.instrumentationSource);
  }

  const manifest = createCompiledAgentManifest({
    agentRoot,
    appRoot,
    channels: variant.channels ?? [],
    config: {
      model: { id: "openai/gpt-5-mini", routing: { kind: "gateway", target: "openai" } },
      name: "fingerprint-host",
      ...(variant.workflowWorld === undefined
        ? {}
        : { experimental: { workflow: { world: variant.workflowWorld } } }),
    },
    schedules: variant.schedules ?? [],
  });

  return {
    appRoot,
    compiledArtifacts: {
      bootstrapPath: join(appRoot, "bootstrap.mjs"),
      instrumentationSourcePath,
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
        ] as CompiledAgentManifest["channels"],
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
