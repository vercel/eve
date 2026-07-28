import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { build, copyPublicAssets, createNitro, prepare, prerender } from "nitro/builder";
import type { Nitro, NitroModuleInput } from "nitro/types";

import { resolvePackageSourceFilePath } from "#internal/application/package.js";

const ASTRO_APPLICATION_SPECIFIER = "./embedded-astro-application.js";

interface BuildEmbeddedAstroNitroOptions {
  readonly astroClientDirectory: string;
  readonly astroServerEntry: string;
  readonly eveModule: NitroModuleInput;
  readonly outputDirectory: string;
  readonly preset: string;
  readonly rootDirectory: string;
}

async function buildNitroOutput(nitro: Nitro): Promise<void> {
  await prepare(nitro);
  await copyPublicAssets(nitro);
  await prerender(nitro);
  await build(nitro);
}

/** Packages a completed Astro server build and eve into one Nitro artifact. */
export async function buildEmbeddedAstroNitro(
  options: BuildEmbeddedAstroNitroOptions,
): Promise<void> {
  const stagingRoot = join(options.rootDirectory, ".eve");
  await mkdir(stagingRoot, { recursive: true });
  const stagingOutputDirectory = await mkdtemp(join(stagingRoot, "astro-nitro-output-"));
  const rendererPath = resolvePackageSourceFilePath(
    "src/internal/nitro/host/embedded-astro-renderer.ts",
  );
  const astroApplicationPlugin = {
    name: "eve:nitro:astro-application",
    resolveId(source: string, importer: string | undefined) {
      return source === ASTRO_APPLICATION_SPECIFIER && importer === rendererPath
        ? options.astroServerEntry
        : undefined;
    },
  };

  try {
    const nitro = await createNitro({
      _cli: { command: "build" },
      buildDir: join(options.rootDirectory, ".eve", "astro-nitro"),
      dev: false,
      modules: [options.eveModule],
      output: { dir: stagingOutputDirectory },
      preset: options.preset,
      publicAssets: [{ baseURL: "/", dir: options.astroClientDirectory, maxAge: 0 }],
      rolldownConfig: { plugins: [astroApplicationPlugin] },
      renderer: {
        handler: rendererPath,
      },
      rollupConfig: { plugins: [astroApplicationPlugin] },
      rootDir: options.rootDirectory,
      serverDir: false,
    });

    try {
      await buildNitroOutput(nitro);
    } finally {
      await nitro.close();
    }

    await rm(options.outputDirectory, { force: true, recursive: true });
    await rename(stagingOutputDirectory, options.outputDirectory);
  } finally {
    await rm(stagingOutputDirectory, { force: true, recursive: true });
  }
}
