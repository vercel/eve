import { type HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";

export type OptionalOutputSchema = StandardJSONSchemaV1<unknown, unknown> | undefined;

export type HarnessAgentToolOutput<TOutputSchema extends OptionalOutputSchema = undefined> =
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown>
    ? StandardJSONSchemaV1.InferOutput<TOutputSchema>
    : string;

export interface HarnessAgentSkillFile {
  readonly content: string;
  readonly path: string;
}

export interface HarnessAgentSkill {
  readonly content: string;
  readonly description: string;
  readonly files?: readonly HarnessAgentSkillFile[];
  readonly name: string;
}

export interface HarnessAgentSettings {
  readonly id?: string;
  readonly instructions?: string;
  readonly skills?: readonly HarnessAgentSkill[];
  readonly workingDirectory?: string;
}

export interface HarnessBridgeSettings {
  readonly port: number;
  readonly portEndpoint: { readonly url: string };
}

export const HARNESS_AGENT_TOOL_INPUT_SCHEMA = z.strictObject({
  task: z.string().describe("Task for the coding harness to complete."),
});

export type HarnessAgentToolInput = z.infer<typeof HARNESS_AGENT_TOOL_INPUT_SCHEMA>;

export interface CreateHarnessAgentToolSettings<
  TOutputSchema extends OptionalOutputSchema = undefined,
> extends HarnessAgentSettings {
  /** Model-facing description for this HarnessAgent tool. */
  readonly description: string;
  /** Harness creator callback. */
  readonly harness: (settings: HarnessBridgeSettings) => HarnessAgentAdapter;
  /** Optional model override for the harness. Otherwise it'll use its default model. */
  readonly model?: string;
  /** Structured result required from the harness and returned by this eve tool. */
  readonly outputSchema?: TOutputSchema;
}
