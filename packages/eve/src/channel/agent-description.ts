import type { CompiledAgentManifest, CompiledToolDefinition } from "#compiler/manifest.js";
import {
  comparePaths,
  createCompiledSkillFileSource,
  readSkillFile,
  type SkillFileSource,
  SkillReadError,
} from "#channel/skill-files.js";
import { isInvocableCompiledTool } from "#channel/tool-eligibility.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import {
  getRuntimeCompiledArtifactsCacheKey,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { getActiveRuntimeSession } from "#runtime/sessions/runtime-session.js";
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

/** One file of a skill, as `listSkillFiles` returns it. `readSkill` rejects files over 512 KiB. */
export interface AgentSkillFileDescription {
  /** `/`-separated path under the skill root, e.g. `references/api.md`. */
  readonly path: string;
  /** Size in bytes. */
  readonly size: number;
}

/** One compiled skill. `listSkillFiles` enumerates its files. */
export interface AgentSkillDescription {
  readonly name: string;
  readonly description: string;
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

/** The `describe`, `listSkillFiles`, and `readSkill` route handler args. */
export interface AgentDescriptionRouteArgs {
  describe(): Promise<AgentDescription>;
  listSkillFiles(skill: string): Promise<readonly AgentSkillFileDescription[]>;
  readSkill(skill: string, path?: string): Promise<Uint8Array>;
}

/**
 * One compiled agent as its routes see it: the description projected from
 * its manifest, and the source of its skill files. Loading it reads the
 * manifest only; no skill file is touched until one is listed or read.
 */
export interface DescribedAgent {
  readonly description: AgentDescription;
  readonly files: SkillFileSource;
}

/**
 * Loads the agent of a compiled artifacts source once per artifact version
 * on the active runtime session, as `getCompiledRuntimeAgentBundle` does for
 * the execution graph, without resolving that graph. A production build
 * loads once per process; `eve dev` reloads after each recompile. A failed
 * load is retried on the next call rather than cached.
 */
export async function loadDescribedAgent(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<DescribedAgent> {
  const session = getActiveRuntimeSession();
  const sourceKey = getRuntimeCompiledArtifactsCacheKey(compiledArtifactsSource);
  const version = await resolveRuntimeCompiledArtifactsVersionedCacheKey(compiledArtifactsSource);
  const cached = session.describedAgents.get(sourceKey);
  if (cached?.version === version) return await cached.agent;
  const agent = loadCompiledManifest({ compiledArtifactsSource }).then(
    (manifest): DescribedAgent => ({
      description: describeCompiledAgent(manifest),
      files: createCompiledSkillFileSource({
        compiledArtifactsSource,
        workspaceResourceRoot: manifest.workspaceResourceRoot,
      }),
    }),
  );
  agent.catch(() => {
    if (session.describedAgents.get(sourceKey)?.agent === agent) {
      session.describedAgents.delete(sourceKey);
    }
  });
  session.describedAgents.set(sourceKey, { agent, version });
  return await agent;
}

/**
 * The agent route handler args for one compiled artifacts source, which
 * resolves on first use so routes that never call them pay nothing. Also
 * returns the agent's skill files, so a channel that already holds listed
 * paths reads them without the listing `readSkill` repeats per call.
 */
export function createAgentDescriptionRouteArgs(
  resolveCompiledArtifactsSource: () => RuntimeCompiledArtifactsSource,
): { readonly args: AgentDescriptionRouteArgs; readonly skillFiles: SkillFileSource } {
  const load = () => loadDescribedAgent(resolveCompiledArtifactsSource());
  const skillFiles: SkillFileSource = {
    listFiles: async (skill) => await (await load()).files.listFiles(skill),
    listDirectories: async (skill) => await (await load()).files.listDirectories(skill),
    readFile: async (skill, path) => await (await load()).files.readFile(skill, path),
  };
  const assertSkill = async (skill: string) => {
    const { description } = await load();
    if (!description.skills.some((entry) => entry.name === skill)) {
      throw new SkillReadError("unknown-skill", `Unknown skill "${skill}".`);
    }
  };
  return {
    args: {
      describe: async () => (await load()).description,
      async listSkillFiles(skill) {
        await assertSkill(skill);
        return await skillFiles.listFiles(skill);
      },
      async readSkill(skill, path) {
        await assertSkill(skill);
        return await readSkillFile({ path, skill, source: skillFiles });
      },
    },
    skillFiles,
  };
}

/** Projects the root node of a compiled manifest onto {@link AgentDescription}. */
export function describeCompiledAgent(manifest: CompiledAgentManifest): AgentDescription {
  const tools = manifest.tools
    .filter((tool) => isInvocableCompiledTool(manifest, tool))
    .sort((left, right) => comparePaths(left.name, right.name))
    .map(describeTool);
  const skills = [...manifest.skills]
    .sort((left, right) => comparePaths(left.name, right.name))
    .map(({ name, description }) => ({ name, description }));
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
