import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import { computeDevelopmentHostFingerprint } from "#internal/nitro/host/dev-host-fingerprint.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";
import { defineChannel, GET } from "#public/definitions/channel.js";
import { defineSchedule } from "#public/definitions/schedule.js";

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
  readonly instrumentationSlot?: string;
  readonly instrumentationSource?: string;
  readonly schedule?: { readonly cron: string; readonly markdown: string };
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

  return {
    appRoot,
    compiledArtifacts: {
      bootstrapPath: join(appRoot, "bootstrap.mjs"),
      ...(instrumentationSourcePath === undefined
        ? {}
        : {
            instrumentationLayout:
              variant.instrumentationSlot === undefined
                ? ({ kind: "file" } as const)
                : ({ kind: "directory", slots: [variant.instrumentationSlot] } as const),
            instrumentationSourcePaths: [instrumentationSourcePath],
          }),
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

  it("treats channel route topology as structural", async () => {
    const base = await computeDevelopmentHostFingerprint(await createHost());
    const withRoute = await computeDevelopmentHostFingerprint(
      await createHost({
        channel: { path: "/smoke" },
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
        schedule: { cron: "0 0 * * 0", markdown: "Report the weather." },
      }),
    );

    expect(withSchedule).toBe(base);
  });
});
