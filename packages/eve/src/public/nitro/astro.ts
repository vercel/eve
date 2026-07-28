import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { nitro } from "nitro/vite";

import { buildEmbeddedAstroNitro } from "#internal/nitro/host/build-embedded-astro-nitro.js";
import { eveNitro, type EveNitroOptions } from "#public/nitro/module.js";

const ASTRO_SERVER_ENTRY_ID = "virtual:eve-nitro-astro-entry";
const RESOLVED_ASTRO_SERVER_ENTRY_ID = `\0${ASTRO_SERVER_ENTRY_ID}`;

const ASTRO_SERVER_ENTRY_SOURCE = [
  'import { createApp } from "astro/app/entrypoint";',
  "const app = createApp();",
  "export default { fetch: (request) => app.render(request) };",
].join("\n");

/** Configuration for the Astro adapter backed by an embedded Nitro host. */
export interface EveNitroAstroOptions extends EveNitroOptions {
  /** Nitro deployment preset. Defaults to `node-server`. */
  readonly preset?: string;
}

interface AstroConfig {
  readonly build: {
    readonly client: URL;
    readonly server: URL;
    readonly serverEntry: string;
  };
  readonly root: URL;
}

interface AstroConfigSetupContext {
  readonly command: "build" | "dev" | "preview" | "sync";
  updateConfig(config: unknown): void;
}

interface AstroConfigDoneContext {
  readonly config: AstroConfig;
  setAdapter(adapter: unknown): void;
}

interface AstroBuildDoneContext {
  readonly dir: URL;
}

interface EveNitroAstroIntegration {
  readonly name: "eve:nitro:astro";
  readonly hooks: {
    readonly "astro:build:done": (context: AstroBuildDoneContext) => Promise<void>;
    readonly "astro:config:done": (context: AstroConfigDoneContext) => void;
    readonly "astro:config:setup": (context: AstroConfigSetupContext) => void;
  };
}

function createAstroServerEntryPlugin(): object {
  return {
    name: "eve:nitro:astro-entry",
    resolveId(id: string) {
      return id === ASTRO_SERVER_ENTRY_ID ? RESOLVED_ASTRO_SERVER_ENTRY_ID : undefined;
    },
    load(id: string) {
      return id === RESOLVED_ASTRO_SERVER_ENTRY_ID ? ASTRO_SERVER_ENTRY_SOURCE : undefined;
    },
  };
}

/**
 * Runs an Astro server and one filesystem-authored eve agent in the same
 * Nitro development server and production artifact.
 */
export function eveNitroAstro(options: EveNitroAstroOptions = {}): EveNitroAstroIntegration {
  let astroConfig: AstroConfig | undefined;

  return {
    name: "eve:nitro:astro",
    hooks: {
      "astro:config:setup"({ command, updateConfig }) {
        updateConfig({
          vite: {
            plugins: [
              ...(command === "dev"
                ? [eveNitro({ agent: options.agent }), ...nitro({ preset: "nitro-dev" })]
                : []),
              createAstroServerEntryPlugin(),
            ],
          },
        });
      },
      "astro:config:done"({ config, setAdapter }) {
        astroConfig = config;
        setAdapter({
          adapterFeatures: { buildOutput: "server", middlewareMode: "classic" },
          entrypointResolution: "auto",
          name: "eve:nitro:astro",
          serverEntrypoint: ASTRO_SERVER_ENTRY_ID,
          supportedAstroFeatures: {
            hybridOutput: "stable",
            serverOutput: "stable",
            sharpImageService: "stable",
            staticOutput: "unsupported",
          },
        });
      },
      async "astro:build:done"({ dir }) {
        void dir;
        if (astroConfig === undefined) {
          throw new Error("Astro completed a build before the eve Nitro adapter was configured.");
        }

        const rootDirectory = fileURLToPath(astroConfig.root);
        await buildEmbeddedAstroNitro({
          astroClientDirectory: fileURLToPath(astroConfig.build.client),
          astroServerEntry: join(
            fileURLToPath(astroConfig.build.server),
            astroConfig.build.serverEntry,
          ),
          eveModule: eveNitro({ agent: options.agent }).nitro,
          outputDirectory: resolve(rootDirectory, ".output"),
          preset: options.preset ?? "node-server",
          rootDirectory,
        });
      },
    },
  };
}
