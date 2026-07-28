import { createPromptCommandOutput } from "#setup/cli/index.js";
import { captureVercel } from "#setup/primitives/index.js";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";

import { readProjectLink } from "./project-resolution.js";
import type { Prompter } from "./prompter.js";
import { resolveVercelHostFrameworkPreset } from "./scaffold/index.js";
import { isForbiddenApiFailure, normalizeVercelApiResult } from "./vercel-api-failure.js";
import {
  parseVercelJson,
  requireVercelTeamAccess,
  type VercelProjectOperationOptions,
  VERCEL_PROJECT_REQUEST_TIMEOUT_MS,
} from "./vercel-project-api.js";

const VercelProjectFrameworkSchema = z.object({
  framework: z.string().min(1).nullish(),
});

const EVE_FRAMEWORK_PRESET = "eve";

interface EveFrameworkIntegration {
  readonly label: string;
  readonly importSpecifier: string;
}

const EVE_FRAMEWORK_INTEGRATIONS: Readonly<Record<string, EveFrameworkIntegration>> = {
  nextjs: { label: "Next.js", importSpecifier: "eve/next" },
  nuxt: { label: "Nuxt", importSpecifier: "eve/nuxt" },
  nuxtjs: { label: "Nuxt", importSpecifier: "eve/nuxt" },
  sveltekit: { label: "SvelteKit", importSpecifier: "eve/sveltekit" },
};

const FRAMEWORK_INTEGRATION_SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".mts",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);

const FRAMEWORK_INTEGRATION_IGNORED_DIRECTORIES = new Set([
  ".eve",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

export interface CreatedProjectFrameworkOptions extends VercelProjectOperationOptions {
  /** Detects whether project sources already use the eve integration for a host framework. */
  detectFrameworkIntegrationImport?: (
    projectRoot: string,
    importSpecifier: string,
  ) => Promise<boolean>;
  /** Never prompt; ambiguous host framework detections fall back to the eve preset. */
  headless?: boolean;
}

function parseProjectFramework(stdout: string, description: string): string | undefined {
  const parsed = VercelProjectFrameworkSchema.safeParse(parseVercelJson(stdout, description));
  if (!parsed.success) {
    throw new Error(`Could not read Vercel project framework from ${description}.`);
  }
  return parsed.data.framework ?? undefined;
}

async function fetchProjectFramework(
  projectRoot: string,
  team: string,
  projectId: string,
  options: VercelProjectOperationOptions,
): Promise<string | undefined> {
  const result = normalizeVercelApiResult(
    await captureVercel(["api", `/v9/projects/${projectId}`, "--scope", team, "--raw"], {
      cwd: projectRoot,
      signal: options.signal,
      timeoutMs: VERCEL_PROJECT_REQUEST_TIMEOUT_MS,
    }),
  );
  if (result.ok) {
    return parseProjectFramework(result.stdout, `project ${projectId}`);
  }
  if (isForbiddenApiFailure(result.failure)) requireVercelTeamAccess(result.failure);
  throw new Error(`Could not inspect Vercel project "${projectId}". ${result.failure.message}`);
}

async function setProjectFramework(
  projectRoot: string,
  team: string,
  projectId: string,
  framework: string,
  onOutput: ReturnType<typeof createPromptCommandOutput>,
  options: VercelProjectOperationOptions,
): Promise<void> {
  const result = normalizeVercelApiResult(
    await captureVercel(
      [
        "api",
        `/v9/projects/${projectId}`,
        "--scope",
        team,
        "--method",
        "PATCH",
        "--raw-field",
        `framework=${framework}`,
        "--raw",
      ],
      {
        cwd: projectRoot,
        onOutput,
        signal: options.signal,
        timeoutMs: VERCEL_PROJECT_REQUEST_TIMEOUT_MS,
      },
    ),
  );
  if (result.ok) return;
  if (isForbiddenApiFailure(result.failure)) requireVercelTeamAccess(result.failure);
  throw new Error(
    `Could not set Vercel project "${projectId}" framework to ${framework}. ${result.failure.message}`,
  );
}

async function confirmDetectedFramework(
  prompter: Prompter,
  framework: string,
  integration: EveFrameworkIntegration,
): Promise<"keep" | "switch-to-eve"> {
  const keepDetected = await prompter.select<boolean>({
    message: `Vercel detected ${integration.label}. Is this project using ${integration.importSpecifier}?`,
    options: [
      {
        value: true,
        label: `Yes, keep ${framework}`,
        hint: `Use this for a host app that integrates eve through ${integration.importSpecifier}.`,
      },
      {
        value: false,
        label: "No, switch to eve",
        hint: "Use this for a standalone eve agent.",
      },
    ],
  });
  return keepDetected ? "keep" : "switch-to-eve";
}

function sourceMentionsPackageSpecifier(source: string, importSpecifier: string): boolean {
  return (
    source.includes(`"${importSpecifier}"`) ||
    source.includes(`'${importSpecifier}'`) ||
    source.includes(`\`${importSpecifier}\``)
  );
}

async function directoryContainsPackageSpecifier(
  directory: string,
  importSpecifier: string,
): Promise<boolean> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(directory, { encoding: "utf8", withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (FRAMEWORK_INTEGRATION_IGNORED_DIRECTORIES.has(entry.name)) continue;
      if (await directoryContainsPackageSpecifier(entryPath, importSpecifier)) return true;
      continue;
    }
    if (!entry.isFile() || !FRAMEWORK_INTEGRATION_SOURCE_EXTENSIONS.has(extname(entry.name))) {
      continue;
    }
    try {
      if (sourceMentionsPackageSpecifier(await fs.readFile(entryPath, "utf8"), importSpecifier)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

async function detectFrameworkIntegrationImport(
  projectRoot: string,
  importSpecifier: string,
): Promise<boolean> {
  return directoryContainsPackageSpecifier(projectRoot, importSpecifier);
}

async function resolveDetectedFrameworkAction(
  prompter: Prompter,
  projectRoot: string,
  framework: string,
  options: CreatedProjectFrameworkOptions,
): Promise<"keep" | "switch-to-eve"> {
  const integration = EVE_FRAMEWORK_INTEGRATIONS[framework];
  if (integration === undefined) return "switch-to-eve";
  const importDetected = await (
    options.detectFrameworkIntegrationImport ?? detectFrameworkIntegrationImport
  )(projectRoot, integration.importSpecifier);
  if (importDetected) return "keep";
  if (options.headless) return "switch-to-eve";
  return confirmDetectedFramework(prompter, framework, integration);
}

function frameworkPresetLabel(preset: string): string {
  return EVE_FRAMEWORK_INTEGRATIONS[preset]?.label ?? preset;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort alignment of a linked Vercel project's Framework Preset with the
 * host framework the project declares on disk (e.g. Next.js).
 *
 * A project created as a standalone eve agent keeps the `eve` preset; adding a
 * host framework via `eve channels add web` leaves it stale, so the deploy would
 * build the agent instead of the host app. Since that command already deploys on
 * the user's behalf, this switches the preset directly (no prompt) and notes the
 * change. No host framework, an unlinked directory, or an already-correct preset
 * is a no-op; a Vercel API failure warns rather than aborting the deploy.
 */
export async function syncHostFrameworkPreset(
  prompter: Prompter,
  projectRoot: string,
  onOutput: ReturnType<typeof createPromptCommandOutput>,
  options: VercelProjectOperationOptions,
): Promise<void> {
  const hostPreset = await resolveVercelHostFrameworkPreset(projectRoot);
  if (hostPreset === undefined) return;

  const link = await readProjectLink(projectRoot);
  if (link === undefined) return;

  const label = frameworkPresetLabel(hostPreset);

  let current: string | undefined;
  try {
    current = await fetchProjectFramework(projectRoot, link.orgId, link.projectId, options);
  } catch (error) {
    // A cancel isn't an API failure — let it propagate; anything else is
    // best-effort, so warn and skip instead of aborting the deploy.
    if (options.signal?.aborted) throw error;
    prompter.log.warning(
      `Could not check this Vercel project's Framework Preset (${describeError(error)}). If it is not already ${label}, set it under Project Settings → Build and Deployment → Framework Settings before deploying.`,
    );
    return;
  }
  if (current === hostPreset) return;

  const currentLabel = current === undefined ? undefined : frameworkPresetLabel(current);
  const currentPhrase =
    currentLabel === undefined ? "had no Framework Preset set" : `was set to "${currentLabel}"`;

  try {
    await setProjectFramework(
      projectRoot,
      link.orgId,
      link.projectId,
      hostPreset,
      onOutput,
      options,
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    prompter.log.warning(
      `${describeError(error)} Set this Vercel project's Framework Preset to ${label} (Project Settings → Build and Deployment → Framework Settings) before deploying, or the deployment will not build your ${label} app.`,
    );
    return;
  }
  prompter.log.info(
    `This project uses ${label}, but its Vercel Framework Preset ${currentPhrase}; switched it to ${label} so the deployment builds your app.`,
  );
}

export async function ensureCreatedProjectFramework(
  prompter: Prompter,
  projectRoot: string,
  team: string,
  projectId: string,
  onOutput: ReturnType<typeof createPromptCommandOutput>,
  options: CreatedProjectFrameworkOptions,
): Promise<void> {
  const framework = await fetchProjectFramework(projectRoot, team, projectId, options);
  if (framework === EVE_FRAMEWORK_PRESET) return;
  const frameworkAction =
    framework === undefined
      ? "switch-to-eve"
      : await resolveDetectedFrameworkAction(prompter, projectRoot, framework, options);
  if (frameworkAction === "switch-to-eve") {
    await setProjectFramework(
      projectRoot,
      team,
      projectId,
      EVE_FRAMEWORK_PRESET,
      onOutput,
      options,
    );
  }
}
