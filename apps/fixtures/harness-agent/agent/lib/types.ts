import { posix } from "node:path";

import type {
  HarnessAgentAdapter,
  HarnessAgentSettings as NativeHarnessAgentSettings,
} from "@ai-sdk/harness/agent";
import type { HarnessWorkflowState } from "@ai-sdk/workflow-harness";
import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import type { DeepPartial, OutputInterface, ToolSet } from "ai";
import type { ToolContext, WorkflowToolContext } from "eve/tools";
import { z } from "zod";

type DistributiveOmit<TValue, TKey extends PropertyKey> = TValue extends unknown
  ? Omit<TValue, TKey>
  : never;

export type OptionalOutputSchema = StandardJSONSchemaV1<unknown, unknown> | undefined;

export type HarnessAgentToolOutput<TOutputSchema extends OptionalOutputSchema = undefined> =
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown>
    ? StandardJSONSchemaV1.InferOutput<TOutputSchema>
    : string;

type HarnessAgentOutputSpecification<TOutputSchema extends OptionalOutputSchema> = OutputInterface<
  HarnessAgentToolOutput<TOutputSchema>,
  DeepPartial<HarnessAgentToolOutput<TOutputSchema>>,
  never
>;

interface HarnessBridgeSettings {
  readonly port: number;
  readonly portEndpoint: { readonly url: string };
}

export type HarnessAgentToolSettings<
  THarness extends HarnessAgentAdapter<any> = HarnessAgentAdapter,
  TUserTools extends ToolSet = {},
  RuntimeContext extends Record<string, unknown> = Record<string, unknown>,
  TOutputSchema extends OptionalOutputSchema = undefined,
  CallOptions = never,
> = DistributiveOmit<
  NativeHarnessAgentSettings<
    THarness,
    TUserTools,
    RuntimeContext,
    HarnessAgentOutputSpecification<TOutputSchema>,
    CallOptions
  >,
  "harness" | "output" | "stopWhen"
> & {
  readonly harness: (settings: HarnessBridgeSettings) => THarness;
  readonly outputSchema?: TOutputSchema;
};

export const HARNESS_AGENT_TOOL_INPUT_SCHEMA = z.strictObject({
  task: z.string().describe("Task for the coding harness to complete."),
  workDir: z
    .string()
    .min(1, "workDir must not be empty.")
    .refine((workDir) => !workDir.includes("\0"), "workDir must not contain NUL.")
    .refine((workDir) => !workDir.includes("\\"), "workDir must use POSIX path separators.")
    .refine(
      (workDir) => !posix.isAbsolute(workDir),
      "workDir must be relative to the sandbox workspace root.",
    )
    .refine((workDir) => {
      const normalized = posix.normalize(workDir);
      return normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
    }, "workDir must identify a directory within the sandbox workspace root.")
    .optional()
    .describe(
      'Optional POSIX directory path relative to the sandbox workspace root (/workspace), such as "ms" or "packages/eve". Absolute paths, ".", parent traversal, and backslashes are not allowed.',
    ),
});

export type HarnessAgentToolInput = z.infer<typeof HARNESS_AGENT_TOOL_INPUT_SCHEMA>;

export type CreateHarnessAgentToolDefinitionArgs<
  THarness extends HarnessAgentAdapter<any> = HarnessAgentAdapter,
  TUserTools extends ToolSet = {},
  RuntimeContext extends Record<string, unknown> = Record<string, unknown>,
  TOutputSchema extends OptionalOutputSchema = undefined,
  CallOptions = never,
> = {
  readonly description: string;
  readonly settings: HarnessAgentToolSettings<
    THarness,
    TUserTools,
    RuntimeContext,
    TOutputSchema,
    CallOptions
  >;
};

export type CreateHarnessAgentWorkflowToolDefinitionArgs<
  THarness extends HarnessAgentAdapter<any> = HarnessAgentAdapter,
  TUserTools extends ToolSet = {},
  RuntimeContext extends Record<string, unknown> = Record<string, unknown>,
  TOutputSchema extends OptionalOutputSchema = undefined,
  CallOptions = never,
> = CreateHarnessAgentToolDefinitionArgs<
  THarness,
  TUserTools,
  RuntimeContext,
  TOutputSchema,
  CallOptions
>;

type RunHarnessAgentBaseArgs<
  TContext,
  THarness extends HarnessAgentAdapter<any>,
  TUserTools extends ToolSet,
  RuntimeContext extends Record<string, unknown>,
  TOutputSchema extends OptionalOutputSchema,
  CallOptions,
> = {
  readonly ctx: TContext;
  readonly input: HarnessAgentToolInput;
  readonly settings: HarnessAgentToolSettings<
    THarness,
    TUserTools,
    RuntimeContext,
    TOutputSchema,
    CallOptions
  >;
};

export type RunHarnessAgentArgs<
  THarness extends HarnessAgentAdapter<any> = HarnessAgentAdapter,
  TUserTools extends ToolSet = {},
  RuntimeContext extends Record<string, unknown> = Record<string, unknown>,
  TOutputSchema extends OptionalOutputSchema = undefined,
  CallOptions = never,
> = RunHarnessAgentBaseArgs<
  ToolContext,
  THarness,
  TUserTools,
  RuntimeContext,
  TOutputSchema,
  CallOptions
>;

export type RunHarnessAgentStepArgs<
  THarness extends HarnessAgentAdapter<any> = HarnessAgentAdapter,
  TUserTools extends ToolSet = {},
  RuntimeContext extends Record<string, unknown> = Record<string, unknown>,
  TOutputSchema extends OptionalOutputSchema = undefined,
  CallOptions = never,
> = RunHarnessAgentBaseArgs<
  WorkflowToolContext,
  THarness,
  TUserTools,
  RuntimeContext,
  TOutputSchema,
  CallOptions
> & {
  readonly state: HarnessWorkflowState;
};
