import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { runPnpmCommand } from "../../src/internal/testing/run-pnpm-command.js";

const REGISTRY_ROOT = fileURLToPath(new URL("../../../../apps/docs/", import.meta.url));
const WEB_ROOT = "apps/web";

const scenarioApp = useScenarioApp();

interface RegistryItem {
  readonly name: string;
  readonly dependencies?: readonly string[];
  readonly devDependencies?: readonly string[];
  readonly files: readonly { readonly path: string; readonly target: string }[];
}

function dependencyRecord(specifiers: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    specifiers.map((specifier) => {
      const separator = specifier.lastIndexOf("@");
      if (separator <= 0) throw new Error(`Registry dependency ${specifier} has no version.`);
      return [specifier.slice(0, separator), specifier.slice(separator + 1)];
    }),
  );
}

/** The `channel/web-tanstack` item as `eve add channel/web` installs it, in Vercel services hosting. */
async function createChannelTanStackDescriptor(): Promise<ScenarioAppDescriptor> {
  const registry = JSON.parse(await readFile(join(REGISTRY_ROOT, "registry.json"), "utf8")) as {
    readonly items: readonly RegistryItem[];
  };
  const item = registry.items.find((candidate) => candidate.name === "channel/web-tanstack");
  if (item === undefined || item.files.length === 0) {
    throw new Error("apps/docs/registry.json must define channel/web-tanstack with files.");
  }

  const files: Record<string, string> = {
    // Written by `eve integration setup web`, not the registry item.
    [`${WEB_ROOT}/app/eve-agent.ts`]:
      "export const WEB_CHAT_AGENT: string | undefined = undefined;\n",
    "pnpm-workspace.yaml": "minimumReleaseAge: 0\n",
  };
  for (const file of item.files) {
    files[file.target] = await readFile(join(REGISTRY_ROOT, file.path), "utf8");
  }

  return {
    dependencies: {
      ...dependencyRecord(item.dependencies ?? []),
      ...dependencyRecord(item.devDependencies ?? []),
    },
    files,
    installDependencies: true,
    name: "channel-web-tanstack",
  };
}

async function readBuiltCss(appRoot: string): Promise<string> {
  const assetsRoot = join(appRoot, WEB_ROOT, ".output", "public", "assets");
  const stylesheets = (await readdir(assetsRoot)).filter((entry) => entry.endsWith(".css"));
  if (stylesheets.length === 0) throw new Error(`Expected CSS assets in ${assetsRoot}.`);
  const sources = await Promise.all(
    stylesheets.map((entry) => readFile(join(assetsRoot, entry), "utf8")),
  );
  return sources.join("\n");
}

describe("registry channel/web-tanstack", () => {
  it("builds and typechecks the installed TanStack Start Web Chat app", async () => {
    const app = await scenarioApp(await createChannelTanStackDescriptor());

    // The item's `build:web` script. `NITRO_PRESET` keeps the output under
    // `.output/` even when CI or Vercel provider detection would pick another preset.
    await runPnpmCommand({
      args: ["exec", "vite", "build", WEB_ROOT],
      cwd: app.appRoot,
      env: { ...process.env, NITRO_PRESET: "node-server" },
    });
    // Runs after the build, which generates `app/routeTree.gen.ts`.
    await runPnpmCommand({
      args: ["exec", "tsc", "-p", WEB_ROOT],
      cwd: app.appRoot,
    });

    // Font utilities must read the variables so `fonts.css` can swap in the
    // Fontsource families; inlined theme values would hardcode "Geist Mono".
    const css = await readBuiltCss(app.appRoot);
    expect(css).toContain(".font-sans{font-family:var(--font-sans)}");
    expect(css).toContain(".font-mono{font-family:var(--font-mono)}");
  }, 300_000);
});
