import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EVE_SVELTEKIT_SERVICE_PREFIX } from "./routing.js";
import { ensureEveVercelJson } from "./vercel-json.js";

async function createTempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "eve-sveltekit-vercel-"));
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

describe("ensureEveVercelJson", () => {
  it("creates experimentalServices and rewrites when vercel.json is missing", async () => {
    const svelteKitRoot = await createTempRoot();

    const result = await ensureEveVercelJson({
      appRoot: svelteKitRoot,
      eveBuildCommand: "eve build",
      servicePrefix: EVE_SVELTEKIT_SERVICE_PREFIX,
      svelteKitRoot,
    });

    expect(result.servicePrefix).toBe(EVE_SVELTEKIT_SERVICE_PREFIX);
    expect(await readJsonFile(join(svelteKitRoot, "vercel.json"))).toEqual({
      $schema: "https://openapi.vercel.sh/vercel.json",
      experimentalServices: {
        eve: {
          buildCommand: "eve build",
          entrypoint: ".",
          framework: "eve",
          routePrefix: EVE_SVELTEKIT_SERVICE_PREFIX,
        },
        web: {
          entrypoint: ".",
          framework: "sveltekit",
          routePrefix: "/",
        },
      },
      rewrites: [
        {
          source: "/eve/v1/:path*",
          destination: `${EVE_SVELTEKIT_SERVICE_PREFIX}/eve/v1/:path*`,
        },
      ],
    });
  });

  it("resolves the eve entrypoint relative to the SvelteKit root", async () => {
    const svelteKitRoot = await createTempRoot();
    const appRoot = join(svelteKitRoot, "agent");

    await ensureEveVercelJson({
      appRoot,
      eveBuildCommand: "eve build",
      servicePrefix: EVE_SVELTEKIT_SERVICE_PREFIX,
      svelteKitRoot,
    });

    expect(await readJsonFile(join(svelteKitRoot, "vercel.json"))).toMatchObject({
      experimentalServices: {
        eve: { entrypoint: "agent" },
      },
    });
  });

  it("uses a custom build command", async () => {
    const svelteKitRoot = await createTempRoot();

    await ensureEveVercelJson({
      appRoot: svelteKitRoot,
      eveBuildCommand: "pnpm build:eve",
      servicePrefix: EVE_SVELTEKIT_SERVICE_PREFIX,
      svelteKitRoot,
    });

    expect(await readJsonFile(join(svelteKitRoot, "vercel.json"))).toMatchObject({
      experimentalServices: {
        eve: { buildCommand: "pnpm build:eve" },
      },
    });
  });

  it("preserves an already-configured eve service and reuses its prefix", async () => {
    const svelteKitRoot = await createTempRoot();
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
          framework: "sveltekit",
          routePrefix: "/",
        },
      },
      rewrites: [
        {
          source: "/eve/v1/:path*",
          destination: "/private/agent/eve/v1/:path*",
        },
      ],
    };
    await writeFile(join(svelteKitRoot, "vercel.json"), `${JSON.stringify(existing, null, 2)}\n`);

    const result = await ensureEveVercelJson({
      appRoot: svelteKitRoot,
      eveBuildCommand: "eve build",
      servicePrefix: EVE_SVELTEKIT_SERVICE_PREFIX,
      svelteKitRoot,
    });

    expect(result.servicePrefix).toBe("/private/agent");
    expect(await readJsonFile(join(svelteKitRoot, "vercel.json"))).toEqual(existing);
  });

  it("preserves unrelated top-level keys", async () => {
    const svelteKitRoot = await createTempRoot();
    await writeFile(
      join(svelteKitRoot, "vercel.json"),
      `${JSON.stringify({ regions: ["iad1"] }, null, 2)}\n`,
    );

    await ensureEveVercelJson({
      appRoot: svelteKitRoot,
      eveBuildCommand: "eve build",
      servicePrefix: EVE_SVELTEKIT_SERVICE_PREFIX,
      svelteKitRoot,
    });

    expect(await readJsonFile(join(svelteKitRoot, "vercel.json"))).toMatchObject({
      regions: ["iad1"],
      experimentalServices: {
        eve: { framework: "eve" },
        web: { framework: "sveltekit" },
      },
      rewrites: [
        {
          source: "/eve/v1/:path*",
          destination: `${EVE_SVELTEKIT_SERVICE_PREFIX}/eve/v1/:path*`,
        },
      ],
    });
  });

  it("rejects a malformed vercel.json", async () => {
    const svelteKitRoot = await createTempRoot();
    await writeFile(
      join(svelteKitRoot, "vercel.json"),
      `${JSON.stringify(["not", "an", "object"])}\n`,
    );

    await expect(
      ensureEveVercelJson({
        appRoot: svelteKitRoot,
        eveBuildCommand: "eve build",
        servicePrefix: EVE_SVELTEKIT_SERVICE_PREFIX,
        svelteKitRoot,
      }),
    ).rejects.toThrow(/must contain a JSON object/);
  });
});
