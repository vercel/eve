import { join } from "node:path";

import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import { parseJsonObject } from "#shared/json.js";

const VERCEL_HOST_FRAMEWORK_PRESETS: Readonly<Record<string, string>> = {
  "@sveltejs/kit": "sveltekit",
  next: "nextjs",
  nuxt: "nuxtjs",
  nuxt3: "nuxtjs",
  "nuxt-edge": "nuxtjs",
  "nuxt-nightly": "nuxtjs",
};

function hasDependency(packageJson: Record<string, unknown>, name: string): boolean {
  for (const field of ["dependencies", "devDependencies"] as const) {
    const dependencies = packageJson[field];
    if (
      dependencies !== undefined &&
      typeof dependencies === "object" &&
      dependencies !== null &&
      !Array.isArray(dependencies) &&
      typeof (dependencies as Record<string, unknown>)[name] === "string"
    ) {
      return true;
    }
  }
  return false;
}

/** Resolve the Vercel preset for a host framework declared by a project. */
export async function resolveVercelHostFrameworkPreset(
  projectRoot: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<string | undefined> {
  const source = options.source ?? createDiskProjectSource();
  const packageJsonPath = join(projectRoot, "package.json");
  if ((await source.stat(packageJsonPath)) !== "file") return undefined;

  const packageJson = parseJsonObject(JSON.parse(await source.readTextFile(packageJsonPath)));
  for (const [dependency, preset] of Object.entries(VERCEL_HOST_FRAMEWORK_PRESETS)) {
    if (hasDependency(packageJson, dependency)) return preset;
  }
  return undefined;
}

/** Whether a host framework owns the project's top-level Vercel deployment. */
export async function hasVercelHostFramework(
  projectRoot: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<boolean> {
  return (await resolveVercelHostFrameworkPreset(projectRoot, options)) !== undefined;
}
