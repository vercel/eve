import { PROGRAM_MAX_CALLS } from "#execution/code-mode/limits.js";
import { truncateProgramModelOutput } from "#execution/code-mode/result.js";
import {
  DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  parseWorkflowProgramOptions,
} from "#execution/dynamic-workflow/schema.js";
import {
  runWorkflowProgramExecute,
  runWorkflowProgramTask,
} from "#execution/dynamic-workflow/tool.js";
import type { JsonValue } from "#public/events/index.js";
import {
  defineWorkflowTool,
  type WorkflowExecuteToolDefinition,
  type WorkflowTaskToolDefinition,
} from "#public/tools/index.js";
import { attachWorkflowProgramOptions } from "#tools/workflow-program-input.js";
import { defineJsonSchema } from "#tools/schema.js";
import { frameworkTool } from "./framework-tool.js";

/** Options for {@link workflow}, such as the maximum number of child-agent calls and execution mode. */
export type WorkflowToolOptions =
  | {
      /** Maximum child-agent calls per program, from 1 to 128. Defaults to 100. */
      readonly maxSubagents?: number;
      /**
       * How each call runs: `"task"` runs in the background and delivers the result in a
       * `task.result` message, while `"execute"` runs in the foreground so the current turn waits
       * for the result. Defaults to `"task"`.
       */
      readonly mode?: "task" | "execute";
      /** Set `true` with `mode: "execute"` to let programs call the agent's tools and connections. */
      readonly tools?: false;
    }
  | {
      /** Maximum child-agent calls per program, from 1 to 128. Defaults to 100. */
      readonly maxSubagents?: number;
      /** Runs in the foreground so the current turn waits for the result directly. */
      readonly mode: "execute";
      /** Allows programs to call the agent's tools, connections, and agents via `tools` and `search()`. */
      readonly tools: true;
    };

/**
 * Input to the `workflow` tool: the body of an async JavaScript function that orchestrates agents
 * or tools and returns one JSON-serializable value.
 */
export interface WorkflowToolInput {
  /** Async JavaScript function body evaluated inside the isolated workflow runtime. */
  readonly js: string;
}

/** The task workflow tool {@link workflow} returns by default. Each call runs the model's program as a task. */
export type WorkflowTool = WorkflowTaskToolDefinition<WorkflowToolInput, JsonValue>;

/** The foreground workflow tool {@link workflow} returns when `mode` is `"execute"`. */
export type WorkflowExecuteTool = WorkflowExecuteToolDefinition<WorkflowToolInput, JsonValue>;

const workflowProgramAgentContract =
  "Read ctx.agents for available { [name]: { description } } targets. Call ctx.agent(name, { message: string, outputSchema?: object, files?: [{ url: https://..., mediaType, filename? }] }). Each call starts a new agent that does not see this conversation, so put everything it needs in message. It resolves directly to the agent's reply; when outputSchema is provided, the reply matches that schema. It does not return an agent metadata wrapper. The owning agent resolves the target and applies its existing availability and authorization checks.";

const workflowProgramCapabilitiesContract =
  "Call ctx.ask({ prompt, title?, display?, options?, allowFreeform?, initialOptionId? }) to ask the person on this channel and receive their answer. Call ctx.sleep(seconds) to pause durably without holding compute and resolve to { waitedSeconds }. Call ctx.progress(update) to emit a JSON-serializable progress report. console.log output is captured and returned as { result, logs } when non-empty, or attached to the error on failure.";

const workflowInputSchema = defineJsonSchema<WorkflowToolInput>({
  type: "object",
  properties: {
    js: {
      type: "string",
      description: `JavaScript statements executed inside an async function. Supply only the body, without a surrounding function declaration or arrow function. ${workflowProgramAgentContract} ${workflowProgramCapabilitiesContract} Return one JSON-serializable value.`,
    },
  },
  required: ["js"],
  additionalProperties: false,
});

const workflowToolsInputSchema = defineJsonSchema<WorkflowToolInput>({
  type: "object",
  properties: {
    js: {
      type: "string",
      description:
        'JavaScript statements executed inside an async function. Supply only the body, without a surrounding function declaration or arrow function. Call tools, connections, and agents as `await tools.<name>(input)` (`tools["name"](input)` when the name is not an identifier), find unlisted tools with `await search({ query })`, or use `await ctx.agent(name, { message, outputSchema? })` as an alias for agent calls (also accepts `model` when the target tool declares it, such as `agent({ models })`). Return one JSON-serializable value.',
    },
  },
  required: ["js"],
  additionalProperties: false,
});

/** Defines a model-facing workflow tool backed by isolated runtime JavaScript. */
export function workflow(
  options: WorkflowToolOptions & { readonly mode: "execute" },
): WorkflowExecuteTool;
export function workflow(
  options?: WorkflowToolOptions & { readonly mode?: "task"; readonly tools?: false },
): WorkflowTool;
export function workflow(options?: WorkflowToolOptions): WorkflowTool | WorkflowExecuteTool;
export function workflow(options: WorkflowToolOptions = {}): WorkflowTool | WorkflowExecuteTool {
  const normalized = normalizeWorkflowToolOptions(options);
  if (normalized.tools) {
    const description = [
      "Run an async JavaScript function body in the foreground that calls your tools, connections, and agents, and returns one JSON-serializable value.",
      "Runs in the foreground: the current turn waits until the program finishes and receives its result directly.",
      'Call any callable tool, connection tool, or agent by its flat catalog name as `await tools.<name>(input)` (use `tools["name"](input)` when the name is not an identifier).',
      "Call `await search({ query })` to find tools that are not in your tool list.",
      "`await ctx.agent(name, { message, outputSchema? })` is available as an alias for `await tools[name](...)` (also accepts `model` when the target tool declares it, such as `agent({ models })`).",
      "Each call resolves to the tool's output (or an agent's reply, or a value matching `outputSchema` when provided); a failed or rejected call throws.",
      "Start independent calls together with `Promise.all` so concurrent work runs together and approvals are requested at once, and await every call before returning.",
      "There is no fetch, file system, timers, or imports. `console.log` output is captured and returned with the result.",
      `The program may make at most ${String(PROGRAM_MAX_CALLS)} total calls and invoke at most ${String(normalized.maxSubagents)} agents.`,
    ].join(" ");
    return attachWorkflowProgramOptions(
      frameworkTool(
        defineWorkflowTool({
          description,
          execute: runWorkflowProgramExecute,
          inputSchema: workflowToolsInputSchema,
          toModelOutput: truncateProgramModelOutput,
        }),
      ),
      {
        maxSubagents: normalized.maxSubagents,
        tools: true,
      },
    );
  }
  const modeGuidance =
    normalized.mode === "execute"
      ? "Runs in the foreground: the current turn waits until the program finishes and receives its result directly."
      : "Runs in the background as a task: returns a receipt at once and delivers the result in a later task.result message.";
  const description = [
    "Run an async JavaScript function body that orchestrates agents, questions, timers, and progress updates, and returns one JSON-serializable value.",
    modeGuidance,
    workflowProgramAgentContract,
    workflowProgramCapabilitiesContract,
    'Supply the body directly, for example: return await ctx.agent("researcher", { message: "Describe the task" });',
    "Await every ctx.agent, ctx.ask, ctx.sleep, and ctx.progress call before returning.",
    `The program may invoke at most ${String(normalized.maxSubagents)} agents.`,
  ].join(" ");
  const definition =
    normalized.mode === "execute"
      ? frameworkTool(
          defineWorkflowTool({
            description,
            execute: runWorkflowProgramExecute,
            inputSchema: workflowInputSchema,
            toModelOutput: truncateProgramModelOutput,
          }),
        )
      : frameworkTool(
          defineWorkflowTool({
            description,
            inputSchema: workflowInputSchema,
            task: runWorkflowProgramTask,
            toModelOutput: truncateProgramModelOutput,
          }),
        );
  return attachWorkflowProgramOptions(definition, {
    maxSubagents: normalized.maxSubagents,
  });
}

function normalizeWorkflowToolOptions(options: WorkflowToolOptions): {
  readonly maxSubagents: number;
  readonly mode: "task" | "execute";
  readonly tools: boolean;
} {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("workflow options must be an object.");
  }
  const mode = options.mode ?? "task";
  if (mode !== "task" && mode !== "execute") {
    throw new TypeError('workflow mode must be "task" or "execute".');
  }
  if (options.tools !== undefined && typeof options.tools !== "boolean") {
    throw new TypeError("workflow tools must be a boolean.");
  }
  const tools = options.tools === true;
  if (tools && mode !== "execute") {
    throw new TypeError('workflow({ tools: true }) requires mode: "execute".');
  }
  const program = parseWorkflowProgramOptions({
    maxSubagents: options.maxSubagents ?? DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
    ...(tools && { tools: true }),
  });
  return { ...program, mode, tools };
}
