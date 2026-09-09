import { posix } from "node:path";

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
  readonly workDir?: string;
}

export interface HarnessBridgeSettings {
  readonly port: number;
  readonly portEndpoint: { readonly url: string };
}

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

export interface CreateHarnessAgentToolSettings<
  TOutputSchema extends OptionalOutputSchema = undefined,
> extends HarnessAgentSettings {
  /** Model-facing description for this HarnessAgent tool. */
  readonly description: string;
  /** Optional model override for the harness. Otherwise it'll use its default model. */
  readonly model?: string;
  /** Structured result required from the harness and returned by this eve tool. */
  readonly outputSchema?: TOutputSchema;
}
