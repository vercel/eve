import type { CompiledAgentManifest, CompiledToolDefinition } from "#compiler/manifest.js";
import {
  comparePaths,
  createCompiledSkillFileSource,
  readSkillFile,
  type SkillFileSource,
} from "#channel/skill-files.js";
import { isInvocableCompiledTool } from "#channel/tool-eligibility.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import type { JsonObject } from "#shared/json.js";

/** One compiled tool a caller can invoke outside a turn. */
export interface AgentToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  /** The tool declares an approval policy. */
  readonly approval: boolean;
}

/** One file of a skill. `readSkill` rejects files over 512 KiB. */
export interface AgentSkillFileDescription {
  /** `/`-separated path under the skill root, e.g. `references/api.md`. */
  readonly path: string;
  /** Size in bytes. */
  readonly size: number;
}

/** One compiled skill and its files. */
export interface AgentSkillDescription {
  readonly name: string;
  readonly description: string;
  /** Every regular file of the skill, sorted by path, including its `SKILL.md`. */
  readonly files: readonly AgentSkillFileDescription[];
}

/**
 * The caller-facing view of an agent: its name, description, the compiled
 * tools `invokeTool` can run, and its compiled skills, each sorted by name.
 * Unlike `GET /eve/v1/info`, it carries no paths, config, diagnostics, or
 * other inspection detail, so channels can publish it as is. Tools and
 * skills added by dynamic resolvers and subagents are not listed.
 */
export interface AgentDescription {
  readonly name: string;
  readonly description?: string;
  readonly tools: readonly AgentToolDescription[];
  readonly skills: readonly AgentSkillDescription[];
}

interface LoadedAgent {
  readonly manifest: CompiledAgentManifest;
  readonly files: SkillFileSource;
  description?: Promise<AgentDescription>;
}

/** Bundled artifacts cannot change while the process runs, so they load once. */
let bundledAgent: LoadedAgent | undefined;

async function loadAgent(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<LoadedAgent> {
  if (compiledArtifactsSource.kind !== "disk" && bundledAgent !== undefined) return bundledAgent;
  const manifest = await loadCompiledManifest({ compiledArtifactsSource });
  const files = createCompiledSkillFileSource({
    compiledArtifactsSource,
    workspaceResourceRoot: manifest.workspaceResourceRoot,
  });
  const agent: LoadedAgent = { files, manifest };
  if (compiledArtifactsSource.kind !== "disk") bundledAgent = agent;
  return agent;
}

/**
 * The `describe` and `readSkill` route handler args for one compiled agent.
 * The artifacts source resolves on first use, so routes that never call
 * either pay nothing. A production build describes itself once, and every
 * `describe()` call returns that same object; during `eve dev` each call
 * reads the compile output again.
 */
export function createAgentDescriptionRouteArgs(
  resolveCompiledArtifactsSource: () => RuntimeCompiledArtifactsSource,
): {
  describe(): Promise<AgentDescription>;
  readSkill(skill: string, path?: string): Promise<Uint8Array>;
} {
  return {
    async describe() {
      const agent = await loadAgent(resolveCompiledArtifactsSource());
      agent.description ??= describeCompiledAgent(agent.manifest, agent.files);
      // A failed description is retried on the next call rather than cached.
      agent.description.catch(() => {
        agent.description = undefined;
      });
      return await agent.description;
    },
    async readSkill(skill, path) {
      const { files, manifest } = await loadAgent(resolveCompiledArtifactsSource());
      return await readSkillFile({
        path,
        skill,
        skills: manifest.skills.map((entry) => entry.name),
        source: files,
      });
    },
  };
}

/** Projects the root node of a compiled manifest onto {@link AgentDescription}. */
export async function describeCompiledAgent(
  manifest: CompiledAgentManifest,
  files: SkillFileSource,
): Promise<AgentDescription> {
  const tools = manifest.tools
    .filter((tool) => isInvocableCompiledTool(manifest, tool))
    .sort((left, right) => comparePaths(left.name, right.name))
    .map(describeTool);
  const skills = await Promise.all(
    [...manifest.skills]
      .sort((left, right) => comparePaths(left.name, right.name))
      .map(async (skill) => ({
        name: skill.name,
        description: skill.description,
        files: await files.listFiles(skill.name),
      })),
  );
  const description: { -readonly [K in keyof AgentDescription]: AgentDescription[K] } = {
    name: manifest.config.name,
    tools,
    skills,
  };
  if (manifest.config.description !== undefined) {
    description.description = manifest.config.description;
  }
  return description;
}

function describeTool(tool: CompiledToolDefinition): AgentToolDescription {
  const description: { -readonly [K in keyof AgentToolDescription]: AgentToolDescription[K] } = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? {},
    approval: tool.requiresApproval,
  };
  if (tool.outputSchema !== undefined) description.outputSchema = tool.outputSchema;
  return description;
}
