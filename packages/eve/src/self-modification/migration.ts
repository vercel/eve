import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";

const LEGACY_SELF_MODIFICATION_ROOT = "agent/subagents/self-modification";
const LEGACY_FILES = ["agent.ts", "config.ts", "sandbox.ts", "extensions/selfmod.ts"] as const;
const LEGACY_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  "agent.ts": [
    'import { defineSelfModificationAgent } from "eve/self-modification/agent";\n\nimport config from "./config";\n\nexport default defineSelfModificationAgent({\n  config,\n\n  // To use a specific model instead of eve\'s default, add:\n  // model: "provider/model",\n});\n',
  ],
  "sandbox.ts": [
    'import { defineSelfModificationSandbox } from "eve/self-modification/sandbox";\n\nimport config from "./config";\n\nexport default defineSelfModificationSandbox({ config });\n',
  ],
  "config.ts": [
    'import { defineSelfModificationConfig } from "eve/self-modification/config";\n\nexport default defineSelfModificationConfig({});\n',
    'import { defineSelfModificationConfig } from "eve/self-modification/config";\n\nexport default defineSelfModificationConfig({\n  local: { enabled: true },\n});\n',
  ],
  "extensions/selfmod.ts": [
    'import selfModification from "eve/self-modification";\nimport config from "../config";\n\nexport default selfModification(config);\n',
  ],
};

export interface LegacySelfModificationScaffold {
  readonly root: string;
  readonly paths: readonly string[];
  readonly customized: boolean;
  readonly signature: string;
}

/** Reads only the bounded legacy scaffold; consumer modules are never imported or executed. */
export async function detectLegacySelfModificationScaffold(
  appRoot: string,
): Promise<LegacySelfModificationScaffold | undefined> {
  const root = join(appRoot, LEGACY_SELF_MODIFICATION_ROOT);
  const paths = await listFiles(root);
  if (!paths.includes("agent.ts")) return undefined;
  const agent = await readText(join(root, "agent.ts"));
  if (agent === undefined || !agent.includes("defineSelfModificationAgent")) return undefined;

  const expected = new Set(LEGACY_FILES);
  const signature = JSON.stringify(
    await Promise.all(paths.map(async (path) => [path, await readText(join(root, path))] as const)),
  );
  const customized =
    paths.some((path) => !expected.has(path as (typeof LEGACY_FILES)[number])) ||
    (
      await Promise.all(
        Object.entries(LEGACY_DEFAULTS).map(async ([path, contents]) => {
          const actual = await readText(join(root, path));
          return actual === undefined || !contents.includes(actual);
        }),
      )
    ).some(Boolean) ||
    !agent.includes('from "eve/self-modification/agent"') ||
    (await readText(join(root, "sandbox.ts")))?.includes('from "eve/self-modification/sandbox"') !==
      true;

  return {
    root,
    paths: paths.map((path) => join(LEGACY_SELF_MODIFICATION_ROOT, path)),
    customized,
    signature,
  };
}

export async function removeLegacySelfModificationScaffold(
  appRoot: string,
  scaffold: LegacySelfModificationScaffold,
): Promise<void> {
  const current = await detectLegacySelfModificationScaffold(appRoot);
  if (
    current === undefined ||
    current.root !== scaffold.root ||
    current.customized !== scaffold.customized ||
    current.signature !== scaffold.signature
  ) {
    throw new Error(
      "The self-modification scaffold changed while setup was waiting for cleanup approval.",
    );
  }
  await rm(scaffold.root, { recursive: true, force: true });
}

async function listFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
