import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Nitro } from "nitro/types";

import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import type { NitroArtifactsConfigInput } from "#internal/nitro/host/artifacts-config.js";
import { createEveCronHandlerRoute } from "#internal/nitro/host/cron-handler-route.js";
import type { ExternalCronRouteConfig } from "#internal/nitro/routes/external-cron.js";
import type { ScheduleRegistration } from "#runtime/schedules/register.js";

/**
 * Build-time switch for external cron mode on self-hosted (node preset)
 * builds. When truthy, the build registers no Nitro `scheduledTasks` —
 * so the in-process schedule runner never starts — and instead exposes
 * the same unguessable token cron route the Vercel preset uses, plus a
 * manifest the hosting platform reads to drive the clock itself.
 */
export const EVE_EXTERNAL_CRON_ENV_VAR = "EVE_EXTERNAL_CRON";

/**
 * Where the cron manifest lands, relative to the Nitro output directory
 * (`.output/eve/cron-manifest.json` for a default build). The manifest
 * contains the secret route path, so it must stay in build output —
 * readable by whoever ran the build, never served over HTTP.
 */
export const EVE_CRON_MANIFEST_OUTPUT_PATH = join("eve", "cron-manifest.json");

/**
 * Contract of the emitted cron manifest — the self-hosted equivalent of
 * the `config.crons[]` Vercel reads from its build output.
 */
export interface EveCronManifest {
  readonly version: 1;
  readonly cronHandlerRoute: string;
  readonly crons: ReadonlyArray<{
    readonly name: string;
    readonly cron: string;
  }>;
}

export function isExternalCronEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[EVE_EXTERNAL_CRON_ENV_VAR]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * The narrow Nitro surface the external cron wiring needs — structural,
 * so tests can drive it without a full Nitro instance.
 */
export interface ExternalCronNitro {
  hooks: {
    hook(name: "compiled", handler: () => void | Promise<void>): unknown;
  };
  options: Pick<Nitro["options"], "handlers" | "virtual"> & {
    output: Pick<Nitro["options"]["output"], "dir">;
  };
}

/**
 * Registers the external cron dispatch route and schedules the manifest
 * write-out for one external-cron production build.
 *
 * The route handler bakes in the compiled schedule registrations so it
 * can dispatch by cron expression without consulting Nitro's
 * `scheduledTasks` (deliberately left empty in this mode). The manifest
 * is written on `compiled`, once the output directory exists.
 */
export function applyExternalCronHandlerRoute(
  nitro: ExternalCronNitro,
  input: {
    readonly artifactsConfig: NitroArtifactsConfigInput;
    readonly registrations: readonly ScheduleRegistration[];
  },
): string {
  const route = createEveCronHandlerRoute();
  const virtualId = `#eve-route-external-cron`;
  const modulePath = stringifyEsmImportSpecifier(
    resolvePackageSourceFilePath("src/internal/nitro/routes/external-cron.ts"),
  );
  const routeConfig: ExternalCronRouteConfig = {
    artifactsConfig: input.artifactsConfig,
    schedules: input.registrations.map((registration) => ({
      cron: registration.cron,
      name: registration.scheduleId,
      taskName: registration.taskName,
    })),
  };

  nitro.options.handlers.push({
    handler: virtualId,
    method: "POST",
    route,
  });
  nitro.options.virtual[virtualId] = [
    `import { handleExternalCronRequest } from ${modulePath};`,
    `const config = ${JSON.stringify(routeConfig)};`,
    `export default async (event) => handleExternalCronRequest(config, event.req);`,
  ].join("\n");

  const manifest: EveCronManifest = {
    version: 1,
    cronHandlerRoute: route,
    crons: input.registrations.map((registration) => ({
      name: registration.scheduleId,
      cron: registration.cron,
    })),
  };
  nitro.hooks.hook("compiled", async () => {
    await writeEveCronManifest(nitro.options.output.dir, manifest);
  });

  return route;
}

async function writeEveCronManifest(outputDir: string, manifest: EveCronManifest): Promise<void> {
  const manifestPath = join(outputDir, EVE_CRON_MANIFEST_OUTPUT_PATH);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
