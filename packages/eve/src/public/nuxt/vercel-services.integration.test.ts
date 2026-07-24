import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#shared/resolve-eve-binary.js", async () => {
  const { join } = await import("node:path");
  return {
    // Pin resolution to the conventional app-local path so build-command
    // assertions stay deterministic without a real eve install on disk. The
    // real resolver is exercised in resolve-eve-binary.integration.test.ts.
    resolveEveBinaryPath: (appRoot: string) =>
      join(appRoot, "node_modules", "eve", "bin", "eve.js"),
  };
});

import { ensureEveVercelServicesConfig } from "./vercel-services.js";

async function createTempNuxtRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "eve-nuxt-services-"));
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureEveVercelServicesConfig", () => {
  it("generates the eve service when vercel.json is missing", async () => {
    const nuxtRoot = await createTempNuxtRoot();

    const result = await ensureEveVercelServicesConfig({
      appRoot: nuxtRoot,
      nuxtRoot,
    });

    expect(result).toEqual({
      mode: "generated",
      services: {
        eve: {
          buildCommand:
            "cd '../../..' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='.eve/vercel-services/eve/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='.vercel/output' && node 'node_modules/eve/bin/eve.js' build",
          framework: "eve",
          routes: [
            {
              src: "^/eve/v1/(.*)$",
              transforms: [
                {
                  args: "/eve/v1/$1",
                  op: "set",
                  type: "request.path",
                },
              ],
            },
          ],
          root: ".eve/vercel-services/eve",
        },
      },
    });
  });

  it("creates the isolated service build root", async () => {
    const nuxtRoot = await createTempNuxtRoot();

    await ensureEveVercelServicesConfig({ appRoot: nuxtRoot, nuxtRoot });

    expect(await directoryExists(join(nuxtRoot, ".eve", "vercel-services", "eve"))).toBe(true);
  });

  it("uses a custom eve build command verbatim", async () => {
    const nuxtRoot = await createTempNuxtRoot();

    const result = await ensureEveVercelServicesConfig({
      appRoot: nuxtRoot,
      eveBuildCommand: "pnpm build:eve",
      nuxtRoot,
    });

    expect(result.mode).toBe("generated");
    expect(result.mode === "generated" && result.services.eve?.buildCommand).toBe(
      "cd '../../..' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='.eve/vercel-services/eve/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='.vercel/output' && pnpm build:eve",
    );
  });

  it("resolves relative paths for an eve app in a subdirectory", async () => {
    const nuxtRoot = await createTempNuxtRoot();
    const appRoot = join(nuxtRoot, "agent");
    await mkdir(appRoot, { recursive: true });

    const result = await ensureEveVercelServicesConfig({ appRoot, nuxtRoot });

    expect(result.mode === "generated" && result.services.eve?.buildCommand).toBe(
      "cd '../../../agent' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='../.eve/vercel-services/eve/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='../.vercel/output' && node '../node_modules/eve/bin/eve.js' build",
    );
  });

  it("reads vercel.json from a linked Vercel project root", async () => {
    const projectRoot = await createTempNuxtRoot();
    const nuxtRoot = join(projectRoot, "apps", "web");
    await mkdir(join(projectRoot, ".vercel"), { recursive: true });
    await writeFile(join(projectRoot, ".vercel", "project.json"), "{}\n");
    await mkdir(nuxtRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "vercel.json"),
      `${JSON.stringify({
        services: {
          web: { root: "apps/web", framework: "nuxtjs" },
          eve: { root: "agent", framework: "eve" },
        },
      })}\n`,
    );

    const result = await ensureEveVercelServicesConfig({ appRoot: nuxtRoot, nuxtRoot });

    expect(result).toEqual({ mode: "root" });
  });

  it("generates nothing when vercel.json declares services including eve", async () => {
    const nuxtRoot = await createTempNuxtRoot();
    await writeFile(
      join(nuxtRoot, "vercel.json"),
      `${JSON.stringify({
        services: {
          web: { root: ".", framework: "nuxtjs" },
          agent: { root: "agent", framework: "eve" },
        },
      })}\n`,
    );

    const result = await ensureEveVercelServicesConfig({ appRoot: nuxtRoot, nuxtRoot });

    expect(result).toEqual({ mode: "root" });
    expect(await directoryExists(join(nuxtRoot, ".eve", "vercel-services"))).toBe(false);
  });

  it("accepts the named service array form", async () => {
    const nuxtRoot = await createTempNuxtRoot();
    await writeFile(
      join(nuxtRoot, "vercel.json"),
      `${JSON.stringify({
        services: [
          { name: "web", root: ".", framework: "nuxtjs" },
          { name: "eve", root: "agent", framework: "eve" },
        ],
      })}\n`,
    );

    await expect(ensureEveVercelServicesConfig({ appRoot: nuxtRoot, nuxtRoot })).resolves.toEqual({
      mode: "root",
    });
  });

  it("throws when vercel.json services omit the eve service", async () => {
    const nuxtRoot = await createTempNuxtRoot();
    await writeFile(
      join(nuxtRoot, "vercel.json"),
      `${JSON.stringify({ services: { web: { root: ".", framework: "nuxtjs" } } })}\n`,
    );

    await expect(ensureEveVercelServicesConfig({ appRoot: nuxtRoot, nuxtRoot })).rejects.toThrow(
      /already defines services/,
    );
  });

  it("warns and generates when vercel.json only has legacy experimentalServices", async () => {
    const nuxtRoot = await createTempNuxtRoot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeFile(
      join(nuxtRoot, "vercel.json"),
      `${JSON.stringify({
        experimentalServices: {
          web: { entrypoint: ".", framework: "nuxtjs", routePrefix: "/" },
          eve: { entrypoint: ".", framework: "eve", routePrefix: "/_eve_internal/eve" },
        },
      })}\n`,
    );

    const result = await ensureEveVercelServicesConfig({ appRoot: nuxtRoot, nuxtRoot });

    expect(result.mode).toBe("generated");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("experimentalServices"));
  });

  it("prefers stable services over legacy experimentalServices without warning", async () => {
    const nuxtRoot = await createTempNuxtRoot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeFile(
      join(nuxtRoot, "vercel.json"),
      `${JSON.stringify({
        experimentalServices: { eve: { entrypoint: ".", framework: "eve", routePrefix: "/x" } },
        services: { eve: { root: ".", framework: "eve" } },
      })}\n`,
    );

    const result = await ensureEveVercelServicesConfig({ appRoot: nuxtRoot, nuxtRoot });

    expect(result).toEqual({ mode: "root" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects a malformed vercel.json", async () => {
    const nuxtRoot = await createTempNuxtRoot();
    await writeFile(join(nuxtRoot, "vercel.json"), `["not", "an", "object"]\n`);

    await expect(ensureEveVercelServicesConfig({ appRoot: nuxtRoot, nuxtRoot })).rejects.toThrow(
      /must contain a JSON object/,
    );
  });
});
