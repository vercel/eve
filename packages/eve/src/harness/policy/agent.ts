// What a harness composes its agent from. `declared` is what the agent's files declare, as data;
// `builtins` is what eve adds for its own features: its `eve__` tools, and the renderers that turn
// declared data into eve's default prompt. eve's own harness is the plain composition of the two,
// and must reproduce eve's prompt exactly.

import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { sessionSkills } from "#execution/catalog/skills.js";
import { formatAvailableSkillsSection } from "#execution/skills/instructions.js";
import { FINAL_REPLY_TASK_SYSTEM_BLOCK, TASK_SYSTEM_BLOCK } from "#execution/tasks/render.js";
import { CALL_TOOL_NAME, SEARCH_TOOL_NAME, SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { TASK_CANCEL_TOOL_NAME, TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import {
  BUILTIN,
  DECLARED,
  type HarnessBuiltins,
  type HarnessBuiltinTool,
  type HarnessDeclaredAgent,
  type HarnessDeclaredInstructions,
  type HarnessDeclaredSkill,
  type HarnessDeclaredTool,
  type HarnessWorkspace,
} from "#public/definitions/harness.js";
import { HARNESS_INSTRUCTIONS } from "#reactions/kinds/instructions.js";
import { buildDynamicSubagentTools } from "#reactions/kinds/subagent.js";
import { HARNESS_TOOLS } from "#reactions/kinds/tool.js";
import { evaluateDeclared } from "#reactions/runner.js";
import { slotsOf } from "#reactions/state.js";
import {
  agentInstructionsOf,
  PARALLEL_ACTION_INSTRUCTION,
  renderInstructionsBlock,
} from "#runtime/prompt/compose.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { createWorkspacePromptSection } from "#runtime/workspace/spec.js";
import type { WorkspaceRuntimeSpec } from "#runtime/workspace/types.js";

/** Where a declared entry comes from, which eve's default prompt reads. */
const ORIGIN = Symbol("eve.harness.origin");

/** The description a declared tool's data came with, so a copy that changes it is noticed. */
export const DESCRIBED = Symbol.for("eve.harness.described");

/** The container a harness's context reads from. */
export const CONTAINER = Symbol.for("eve.harness.container");

/**
 * What eve's renderers need to know about the step: whether the session offers tasks, and whether
 * its caller reads only the final reply. The kernel sets them where it evaluates the agent.
 */
export interface RenderFacts {
  readonly offersTasks: boolean;
  readonly finalReplyOnly: boolean;
}

/** Process-wide, since an agent's bundled code holds its own copy of this module. */
const renderFacts: WeakMap<ContextContainer, RenderFacts> = ((
  globalThis as Record<symbol, unknown>
)[Symbol.for("eve.harness.renderFacts")] ??= new WeakMap()) as never;

/** Runs `fn` with what the renderers know about the step. */
export async function withRenderFacts<T>(
  ctx: ContextContainer,
  facts: RenderFacts,
  fn: () => Promise<T>,
): Promise<T> {
  renderFacts.set(ctx, facts);
  try {
    return await fn();
  } finally {
    renderFacts.delete(ctx);
  }
}

/** The built-in tools a harness can offer, by name. */
export const BUILTIN_TOOL_NAMES = [
  SKILL_TOOL_NAME,
  SEARCH_TOOL_NAME,
  CALL_TOOL_NAME,
  TASK_WAIT_TOOL_NAME,
  TASK_CANCEL_TOOL_NAME,
  REPLY_TOOL_NAME,
] as const;

/**
 * What the agent's files declare, as data. The values a harness hasn't asked for yet are
 * evaluated now, under their own IDs and memos; a harness that never asks never evaluates them.
 */
export async function declared(ctx: object): Promise<HarnessDeclaredAgent> {
  const container = containerOf(ctx);
  await evaluateDeclared(container);
  return declaredNow(container);
}

/** What eve adds for its own features: its tools, and its renderers. */
export function builtins(ctx: object): HarnessBuiltins {
  const facts = renderFacts.get(containerOf(ctx));
  return {
    prompt: {
      instructions: (files) => defaultPrompt(files, facts),
      skills: renderSkills,
      tasks: () => renderTasks(facts),
      tools: renderTools,
      workspace: renderWorkspace,
    },
    tools: Object.fromEntries(BUILTIN_TOOL_NAMES.map((name) => [name, builtinTool(name)])),
  };
}

function containerOf(ctx: object): ContextContainer {
  const container = (ctx as { readonly [CONTAINER]?: ContextContainer })[CONTAINER];
  if (container === undefined) {
    throw new Error("Pass the harness's ctx: declared(ctx) and builtins(ctx) read the session.");
  }
  return container;
}

/** The declared data the session's slots hold now, with the bundle's static definitions. */
export function declaredNow(ctx: ContextReader): HarnessDeclaredAgent {
  const bundle = ctx.get(BundleKey);
  const block = agentInstructionsOf(bundle?.resolvedAgent.instructions);
  const instructions: Record<string, HarnessDeclaredInstructions> = {
    agent: withOrigin({ content: block?.content ?? "", role: "system" }, block?.name),
  };
  for (const { id, slot } of slotsOf(ctx, "instructions")) {
    if (id === HARNESS_INSTRUCTIONS) continue;
    const value = slot.value as HarnessDeclaredInstructions | null;
    if (value !== null) instructions[id.slice("instructions:".length)] = value;
  }
  const staticSkills = new Set((bundle?.resolvedAgent.skills ?? []).map(({ name }) => name));
  const skills: HarnessDeclaredSkill[] = [...sessionSkills(ctx).values()].map((skill) =>
    withOrigin(
      {
        deferred: skill.deferred,
        description: skill.description,
        load: async () => skill.markdown,
        name: skill.name,
      },
      staticSkills.has(skill.name) ? "static" : "dynamic",
    ),
  );
  const tools: Record<string, HarnessDeclaredTool> = {};
  const add = (
    tool: { readonly name: string; readonly description: string; readonly deferred?: boolean },
    origin: string,
  ) => {
    tools[tool.name] = withOrigin(
      {
        description: tool.description,
        name: tool.name,
        ...(tool.deferred === true && { deferred: true }),
        [DECLARED]: tool.name,
        [DESCRIBED]: tool.description,
      },
      origin,
    );
  };
  for (const tool of bundle?.turnAgent.tools ?? []) add(tool, "static");
  for (const tool of buildDynamicSubagentTools(ctx)) add(tool, "dynamic");
  for (const { id, slot } of slotsOf(ctx, "tool")) {
    if (id === HARNESS_TOOLS || !Array.isArray(slot.value)) continue;
    for (const tool of slot.value as readonly { name: string; description: string }[]) {
      add(tool, "dynamic");
    }
  }
  for (const connection of ctx.get(ConnectionRegistryKey)?.getConnections() ?? []) {
    add({ ...connection, deferred: true, name: connection.connectionName }, "connection");
  }
  const workspace = bundle?.turnAgent.promptWorkspaceSpec ?? bundle?.turnAgent.workspaceSpec;
  return {
    instructions,
    model: { [DECLARED]: "model" },
    skills,
    tools,
    ...(workspace !== undefined && {
      workspace: withOrigin({ [DECLARED]: "workspace" } as HarnessWorkspace, workspace),
    }),
  };
}

function withOrigin<T extends object>(value: T, origin: unknown): T {
  return Object.assign(value, { [ORIGIN]: origin });
}

function originOf<T>(value: object | undefined): T | undefined {
  return (value as { readonly [ORIGIN]?: T } | undefined)?.[ORIGIN];
}

function builtinTool(name: string): HarnessBuiltinTool {
  return { name, [BUILTIN]: name };
}

/** The name of the built-in tool `value` is, if it is one. */
export function builtinName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !(BUILTIN in value)) return undefined;
  const name = (value as HarnessBuiltinTool)[BUILTIN];
  return typeof name === "string" ? name : undefined;
}

/** The name of the declared entry `value` is, if it is one. */
export function declaredName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !(DECLARED in value)) return undefined;
  const name = (value as HarnessDeclaredTool)[DECLARED];
  return typeof name === "string" ? name : undefined;
}

/**
 * eve's default prompt for `files`: the agent's instructions, the workspace, the note on parallel
 * calls when the agent's files declare tools, and the skills that aren't deferred, as one part;
 * then each dynamic system instruction, and the note on tasks. One part alone is a string.
 */
function defaultPrompt(
  files: HarnessDeclaredAgent,
  facts: RenderFacts | undefined,
): string | readonly string[] {
  const { agent, ...rest } = files.instructions;
  const base = [
    agent === undefined ? "" : renderAgent(agent),
    renderWorkspace(files.workspace),
    renderTools(
      Object.fromEntries(
        Object.entries(files.tools).filter(([, tool]) => originOf(tool) === "static"),
      ),
    ),
    renderSkills(files.skills.filter((skill) => originOf(skill) === "static")),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  const after = [
    ...Object.values(rest).flatMap((entry) =>
      entry.role === "system" && entry.content !== "" ? [entry.content] : [],
    ),
    renderTasks(facts),
  ].filter((part) => part !== "");
  return after.length === 0 ? base : [base, ...after];
}

function renderAgent(agent: HarnessDeclaredInstructions): string {
  if (agent.content.trim() === "") return "";
  const name = originOf<string>(agent);
  // Copied from elsewhere, an entry has no file name: it's its content.
  return name === undefined ? agent.content : renderInstructionsBlock({ ...agent, name });
}

function renderSkills(skills: readonly HarnessDeclaredSkill[]): string {
  return (
    formatAvailableSkillsSection(
      skills
        .filter((skill) => !skill.deferred)
        .map(({ description, name }) => ({ description, name })),
    ) ?? ""
  );
}

function renderWorkspace(workspace: HarnessWorkspace | undefined): string {
  const spec = originOf<WorkspaceRuntimeSpec>(workspace);
  return spec === undefined ? "" : (createWorkspacePromptSection(spec) ?? "");
}

function renderTools(tools: HarnessDeclaredAgent["tools"]): string {
  return Object.keys(tools).length === 0 ? "" : PARALLEL_ACTION_INSTRUCTION;
}

function renderTasks(facts: RenderFacts | undefined): string {
  if (facts?.offersTasks !== true) return "";
  return facts.finalReplyOnly ? FINAL_REPLY_TASK_SYSTEM_BLOCK : TASK_SYSTEM_BLOCK;
}

/** eve's own prompt: its default prompt for what the agent's files declare now. */
export function nativeInstructions(
  ctx: ContextReader | undefined,
  facts: RenderFacts,
): string | readonly string[] {
  return ctx === undefined ? "" : defaultPrompt(declaredNow(ctx), facts);
}
