import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import pc from "#compiled/picocolors/index.js";

import { assertValidPublicAgentName } from "#internal/agent-name.js";
import { findEveProjectContext } from "#internal/project-context.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import { validateModelSlug } from "#setup/flows/model-source-change.js";
import { pathExists } from "#setup/path-exists.js";
import { createPrompter } from "#setup/prompter.js";
import { agentTemplateFiles } from "#setup/scaffold/create/project.js";
import { writeTextFile } from "#setup/scaffold/files.js";

export interface InitCommandOptions {
  agents?: readonly string[];
  channelWebNextjs?: boolean;
  model?: string;
  reasoning?: AgentReasoningDefinition;
}

export interface InitCliLogger {
  error(message: string): void;
  log(message: string): void;
}

function validateAgentNames(names: readonly string[]): void {
  if (names.length === 0) throw new Error("--agents requires at least one agent name.");
  const unique = new Set<string>();
  for (const name of names) {
    assertValidPublicAgentName(name, "Agent");
    if (unique.has(name)) throw new Error(`Agent name ${JSON.stringify(name)} is repeated.`);
    unique.add(name);
  }
}

async function writeWorkspaceAgent(
  workspaceRoot: string,
  name: string,
  options: InitCommandOptions,
): Promise<void> {
  const appRoot = join(workspaceRoot, "agents", name);
  if (await pathExists(appRoot)) {
    throw new Error(
      `Cannot create agent ${JSON.stringify(name)} because ${appRoot} already exists.`,
    );
  }
  const files = agentTemplateFiles(options.model ?? DEFAULT_AGENT_MODEL_ID, options.reasoning);
  await Promise.all(
    Object.entries(files).map(([path, content]) => writeTextFile(join(appRoot, path), content)),
  );
}

export async function convertScaffoldToAgentWorkspace(
  projectRoot: string,
  names: readonly string[],
  options: InitCommandOptions,
): Promise<void> {
  validateAgentNames(names);
  if (options.channelWebNextjs === true) {
    throw new Error("--channel-web-nextjs cannot be combined with --agents.");
  }
  const [first, ...remaining] = names;
  await mkdir(join(projectRoot, "agents", first!), { recursive: true });
  await rename(join(projectRoot, "agent"), join(projectRoot, "agents", first!, "agent"));
  const tsconfigPath = join(projectRoot, "tsconfig.json");
  const tsconfig = await readFile(tsconfigPath, "utf8");
  await writeTextFile(tsconfigPath, tsconfig.replace('"agent/**/*.ts"', '"agents/**/*.ts"'), {
    force: true,
  });
  for (const name of remaining) await writeWorkspaceAgent(projectRoot, name, options);
}

export async function addAgentsToWorkspace(
  logger: InitCliLogger,
  workspaceRoot: string,
  target: string | undefined,
  options: InitCommandOptions,
  validateModel: typeof validateModelSlug = validateModelSlug,
): Promise<boolean> {
  const context = await findEveProjectContext(workspaceRoot);
  if (context?.kind !== "workspace") return false;
  if (options.channelWebNextjs === true) {
    throw new Error("--channel-web-nextjs is not supported when adding a workspace agent.");
  }
  let names = options.agents;
  if (target !== undefined && names !== undefined) {
    throw new Error("Pass either an agent name or --agents, not both.");
  }
  if (names === undefined && target !== undefined) names = [target];
  if (names === undefined) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      throw new Error(
        "This directory is an eve agent workspace. Pass an agent name, for example: eve init billing.",
      );
    }
    names = [await createPrompter().text({ message: "Name the new agent" })];
  }
  validateAgentNames(names);
  if (options.model !== undefined) {
    const rejection = await validateModel(workspaceRoot, options.model);
    if (rejection !== null) throw new Error(rejection);
  }
  for (const name of names) await writeWorkspaceAgent(workspaceRoot, name, options);
  logger.log(
    `${pc.green("✓")} Added ${names.length === 1 ? "agent" : "agents"} ${names.map((name) => pc.bold(name)).join(", ")}`,
  );
  logger.log(pc.dim("$ eve dev --agent <name>"));
  return true;
}
