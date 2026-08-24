import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

export type HarnessAgentHarness =
  | "claude-code"
  | "cline"
  | "codex"
  | "deepagents"
  | "grok-build"
  | "opencode"
  | "pi";

export interface HarnessAgentSkillFile {
  readonly path: string;
  readonly content: string;
}

export interface HarnessAgentSkill {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly files?: readonly HarnessAgentSkillFile[];
}

export interface HarnessAgentSettings {
  readonly id?: string;
  readonly instructions?: string;
  readonly skills?: readonly HarnessAgentSkill[];
  readonly workingDirectory?: string;
}

export interface HarnessAgentToolInput extends HarnessAgentSettings {
  readonly task: string;
  readonly harness: HarnessAgentHarness;
  readonly model?: string;
}

export interface FixedHarnessAgentToolInput {
  readonly task: string;
  readonly harness: HarnessAgentHarness;
}

export interface CreateHarnessAgentToolSettings<
  TOutputSchema extends StandardJSONSchemaV1<unknown, unknown> | undefined = undefined,
> extends HarnessAgentSettings {
  /** Model-facing description for this preconfigured HarnessAgent tool. */
  readonly description: string;
  /** Harnesses exposed to the calling model. Defaults to all supported harnesses. */
  readonly harnesses?: "all" | readonly HarnessAgentHarness[];
  /** Optional model override for each harness. Omitted harnesses use their native default model. */
  readonly models?: Readonly<Partial<Record<HarnessAgentHarness, string>>>;
  /** Structured result required from the harness and returned by this eve tool. */
  readonly outputSchema?: TOutputSchema;
}
