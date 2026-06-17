import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EVE_NUXT_SERVICE_PREFIX } from "./routing.js";
import { ensureEveVercelJson } from "./vercel-json.js";

async function createTempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "eve-nuxt-vercel-"));
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

describe("ensureEveVercelJson", () => {
  it("creates experimentalServices when vercel.json is missing", async () => {
    const nuxtRoot = await createTempRoot();

    const result = await ensureEveVercelJson({
      appRoot: nuxtRoot,
      eveBuildCommand: "eve build",
      nuxtRoot,
      servicePrefix: EVE_NUXT_SERVICE_PREFIX,
    });

    expect(result.servicePrefix).toBe(EVE_NUXT_SERVICE_PREFIX);
    expect(await readJsonFile(join(nuxtRoot, "vercel.json"))).toEqual({
      $schema: "https://openapi.vercel.sh/vercel.json",
      experimentalServices: {
        eve: {
          buildCommand: "eve build",
          entrypoint: ".",
          framework: "eve",
          routePrefix: EVE_NUXT_SERVICE_PREFIX,
        },
        web: {
          entrypoint: ".",
          framework: "nuxtjs",
          routePrefix: "/",
        },
      },
    });
  });

  it("resolves the eve entrypoint relative to the Nuxt root", async () => {
    const nuxtRoot = await createTempRoot();
    const appRoot = join(nuxtRoot, "agent");

    await ensureEveVercelJson({
      appRoot,
      eveBuildCommand: "eve build",
      nuxtRoot,
      servicePrefix: EVE_NUXT_SERVICE_PREFIX,
    });

    expect(await readJsonFile(join(nuxtRoot, "vercel.json"))).toMatchObject({
      experimentalServices: {
        eve: { entrypoint: "agent" },
      },
    });
  });

  it("uses a custom build command", async () => {
    const nuxtRoot = await createTempRoot();

    await ensureEveVercelJson({
      appRoot: nuxtRoot,
      eveBuildCommand: "pnpm build:eve",
      nuxtRoot,
      servicePrefix: EVE_NUXT_SERVICE_PREFIX,
    });

    expect(await readJsonFile(join(nuxtRoot, "vercel.json"))).toMatchObject({
      experimentalServices: {
        eve: { buildCommand: "pnpm build:eve" },
      },
    });
  });

  it("preserves an already-configured eve service and reuses its prefix", async () => {
    const nuxtRoot = await createTempRoot();
    const existing = {
      $schema: "https://openapi.vercel.sh/vercel.json",
      experimentalServices: {
        agent: {
          entrypoint: "agent",
          framework: "eve",
          routePrefix: "/private/agent",
        },
        frontend: {
          entrypoint: ".",
          framework: "nuxtjs",
          routePrefix: "/",
        },
      },
    };
    await writeFile(join(nuxtRoot, "vercel.json"), `${JSON.stringify(existing, null, 2)}\n`);

    const result = await ensureEveVercelJson({
      appRoot: nuxtRoot,
      eveBuildCommand: "eve build",
      nuxtRoot,
      servicePrefix: EVE_NUXT_SERVICE_PREFIX,
    });

    expect(result.servicePrefix).toBe("/private/agent");
    expect(await readJsonFile(join(nuxtRoot, "vercel.json"))).toEqual(existing);
  });

  it("preserves unrelated top-level keys", async () => {
    const nuxtRoot = await createTempRoot();
    await writeFile(
      join(nuxtRoot, "vercel.json"),
      `${JSON.stringify({ regions: ["iad1"] }, null, 2)}\n`,
    );

    await ensureEveVercelJson({
      appRoot: nuxtRoot,
      eveBuildCommand: "eve build",
      nuxtRoot,
      servicePrefix: EVE_NUXT_SERVICE_PREFIX,
    });

    expect(await readJsonFile(join(nuxtRoot, "vercel.json"))).toMatchObject({
      regions: ["iad1"],
      experimentalServices: {
        eve: { framework: "eve" },
        web: { framework: "nuxtjs" },
      },
    });
  });

  it("rejects a malformed vercel.json", async () => {
    const nuxtRoot = await createTempRoot();
    await writeFile(join(nuxtRoot, "vercel.json"), `${JSON.stringify(["not", "an", "object"])}\n`);

    await expect(
      ensureEveVercelJson({
        appRoot: nuxtRoot,
        eveBuildCommand: "eve build",
        nuxtRoot,
        servicePrefix: EVE_NUXT_SERVICE_PREFIX,
      }),
    ).rejects.toThrow(/must contain a JSON object/);
  });
});
