import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeVercelServiceCrons } from "#internal/nitro/host/normalize-vercel-service-crons.js";

const temporaryRoots: string[] = [];

async function createOutputDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `eve-service-crons-${name}-`));
  temporaryRoots.push(directory);
  return directory;
}

async function writeOutputConfig(
  outputDirectory: string,
  config: Record<string, unknown>,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

async function readOutputConfig(
  outputDirectory: string,
): Promise<Record<string, unknown> & { crons?: unknown[] }> {
  return JSON.parse(await readFile(join(outputDirectory, "config.json"), "utf8")) as Record<
    string,
    unknown
  > & { crons?: unknown[] };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("normalizeVercelServiceCrons", () => {
  it("prefixes only eve cron paths and preserves the rest of the service config", async () => {
    const outputDirectory = await createOutputDirectory("named");
    await writeOutputConfig(outputDirectory, {
      crons: [
        { path: "/api/service-cleanup", schedule: "0 0 * * *" },
        { path: "/eve/v1/cron/current", schedule: "*/15 * * * *" },
        { path: "/eve/v1/cron/current", schedule: "*/15 * * * *" },
        {
          path: "/eve/agents/support/eve/v1/cron/keep",
          schedule: "*/5 * * * *",
        },
      ],
      routes: [{ handle: "filesystem" }],
      version: 3,
    });

    await normalizeVercelServiceCrons({
      publicRoutePrefix: "/eve/agents/billing/",
      serviceOutputDirectory: outputDirectory,
    });
    await normalizeVercelServiceCrons({
      publicRoutePrefix: "/eve/agents/billing/",
      serviceOutputDirectory: outputDirectory,
    });

    await expect(readOutputConfig(outputDirectory)).resolves.toEqual({
      crons: [
        { path: "/api/service-cleanup", schedule: "0 0 * * *" },
        {
          path: "/eve/agents/billing/eve/v1/cron/current",
          schedule: "*/15 * * * *",
        },
        {
          path: "/eve/agents/support/eve/v1/cron/keep",
          schedule: "*/5 * * * *",
        },
      ],
      routes: [{ handle: "filesystem" }],
      version: 3,
    });
  });

  it("deduplicates default-agent crons without changing their paths", async () => {
    const outputDirectory = await createOutputDirectory("default");
    await writeOutputConfig(outputDirectory, {
      crons: [
        { path: "/eve/v1/cron/current", schedule: "*/15 * * * *" },
        { path: "/eve/v1/cron/current", schedule: "*/15 * * * *" },
      ],
      version: 3,
    });

    await normalizeVercelServiceCrons({
      serviceOutputDirectory: outputDirectory,
    });

    expect((await readOutputConfig(outputDirectory)).crons).toEqual([
      { path: "/eve/v1/cron/current", schedule: "*/15 * * * *" },
    ]);
  });

  it("leaves service output without schedules unchanged", async () => {
    const outputDirectory = await createOutputDirectory("empty");
    await writeOutputConfig(outputDirectory, {
      routes: [{ handle: "filesystem" }],
      version: 3,
    });
    const configPath = join(outputDirectory, "config.json");
    const before = await readFile(configPath, "utf8");

    await normalizeVercelServiceCrons({
      publicRoutePrefix: "/eve/agents/billing",
      serviceOutputDirectory: outputDirectory,
    });

    await expect(readFile(configPath, "utf8")).resolves.toBe(before);
  });
});
