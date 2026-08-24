import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { z } from "#compiled/zod/index.js";

import { HARNESS_AGENT_HARNESSES } from "#execution/harness-agent/adapter.js";
import { runHarnessAgent } from "#execution/harness-agent/run.js";
import {
  type DefineFixedHarnessAgentToolSettings,
  type DynamicHarnessAgentToolInput,
  type FixedHarnessAgentToolInput,
  type HarnessAgentHarness,
} from "#execution/harness-agent/types.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

type FixedHarnessAgentToolRuntimeSettings = Omit<
  DefineFixedHarnessAgentToolSettings<StandardJSONSchemaV1<unknown, unknown> | undefined>,
  "description"
>;

const skillFileSchema = z.strictObject({
  content: z.string(),
  path: z.string(),
});

const skillSchema = z.strictObject({
  content: z.string(),
  description: z.string(),
  files: z.array(skillFileSchema).optional(),
  name: z.string(),
});

const configurableSettingsShape = {
  id: z.string().describe("Optional stable identifier for this HarnessAgent instance.").optional(),
  instructions: z.string().describe("Instructions for the selected coding harness.").optional(),
  skills: z
    .array(skillSchema)
    .describe("Skills made available to the selected coding harness.")
    .optional(),
  workingDirectory: z
    .string()
    .describe("Workspace-relative directory in which the coding harness should work.")
    .optional(),
};

export const DYNAMIC_HARNESS_AGENT_TOOL_INPUT_SCHEMA = z.strictObject({
  harness: z.enum(HARNESS_AGENT_HARNESSES).describe("Coding harness to run."),
  model: z
    .string()
    .describe("Optional model override. Omit this to use the harness's default model.")
    .optional(),
  task: z.string().describe("Task for the coding harness to complete."),
  ...configurableSettingsShape,
});

export async function executeDynamicHarnessAgentTool(input: {
  readonly abortSignal?: AbortSignal;
  readonly sandbox: SandboxSession;
  readonly toolInput: DynamicHarnessAgentToolInput;
}): Promise<string> {
  return await runHarnessAgent<string>({
    abortSignal: input.abortSignal,
    harness: input.toolInput.harness,
    model: input.toolInput.model,
    sandbox: input.sandbox,
    settings: input.toolInput,
    task: input.toolInput.task,
  });
}

export function createFixedHarnessAgentToolRuntime(settings: FixedHarnessAgentToolRuntimeSettings) {
  const enabledHarnesses = resolveEnabledHarnesses(settings.harnesses);
  validateModels({ enabledHarnesses, models: settings.models });

  return {
    async execute(input: {
      readonly abortSignal?: AbortSignal;
      readonly sandbox: SandboxSession;
      readonly toolInput: FixedHarnessAgentToolInput;
    }): Promise<unknown> {
      return await runHarnessAgent({
        abortSignal: input.abortSignal,
        harness: input.toolInput.harness,
        model: settings.models?.[input.toolInput.harness],
        outputSchema: settings.outputSchema,
        sandbox: input.sandbox,
        settings,
        task: input.toolInput.task,
      });
    },
    inputSchema: createFixedInputSchema(enabledHarnesses),
    outputSchema: settings.outputSchema,
  };
}

function resolveEnabledHarnesses(
  harnesses: DefineFixedHarnessAgentToolSettings["harnesses"],
): readonly HarnessAgentHarness[] {
  if (harnesses === undefined || harnesses === "all") {
    return HARNESS_AGENT_HARNESSES;
  }
  if (!Array.isArray(harnesses)) {
    throw new Error('defineFixedHarnessAgentTool harnesses must be "all" or an allowlist.');
  }
  const enabled = [...new Set(harnesses)];
  if (enabled.length === 0) {
    throw new Error("defineFixedHarnessAgentTool requires at least one enabled harness.");
  }
  for (const harness of enabled) {
    if (!HARNESS_AGENT_HARNESSES.includes(harness)) {
      throw new Error(`Unknown HarnessAgent harness "${harness}".`);
    }
  }
  return enabled;
}

function createFixedInputSchema(enabledHarnesses: readonly HarnessAgentHarness[]) {
  return z.strictObject({
    harness: z.enum(enabledHarnesses).describe("Preconfigured coding harness to run."),
    task: z.string().describe("Task for the coding harness to complete."),
  });
}

function validateModels(input: {
  readonly enabledHarnesses: readonly HarnessAgentHarness[];
  readonly models: DefineFixedHarnessAgentToolSettings["models"];
}): void {
  if (input.models === undefined) {
    return;
  }
  const enabled = new Set(input.enabledHarnesses);
  for (const [harness, model] of Object.entries(input.models)) {
    if (!HARNESS_AGENT_HARNESSES.includes(harness as HarnessAgentHarness)) {
      throw new Error(`Unknown HarnessAgent harness model key "${harness}".`);
    }
    if (!enabled.has(harness as HarnessAgentHarness)) {
      throw new Error(`A model was configured for disabled HarnessAgent harness "${harness}".`);
    }
    if (typeof model !== "string" || model.trim().length === 0) {
      throw new Error(`HarnessAgent model for "${harness}" must be a non-empty string.`);
    }
  }
}
