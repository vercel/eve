import { z } from "#compiled/zod/index.js";
import type { SessionAuthContext } from "#channel/types.js";
import { isAgentReasoningDefinition, isRuntimeLanguageModel } from "#internal/runtime-model.js";
import type { AgentReasoningDefinition, AgentStaticModelDefinition } from "#public/index.js";
import { isValidGitRef } from "#shared/git.js";

export interface DeployedSelfModificationAuthorizationContext {
  readonly channel: {
    readonly kind?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
  readonly principal: SessionAuthContext | null;
}

export type DeployedSelfModificationAuthorization = (
  context: DeployedSelfModificationAuthorizationContext,
) => boolean | Promise<boolean>;

/** Values accepted by the `eve/self-modification/remote` extension mount. */
export interface DeployedSelfModificationConfig {
  /** Policy controlling who can delegate to the coding child; errors deny delegation. */
  readonly authorize: DeployedSelfModificationAuthorization;
  /** Application directory relative to the repository root. Defaults to `"."`. */
  readonly directory?: string;
  /** Branch against which changes are proposed. Defaults to `"main"`. */
  readonly baseBranch?: string;
  /** GitHub repository and the Vercel Connect connector that authenticates to it. */
  readonly github: {
    /** Repository in owner/repository form. */
    readonly repository: string;
    readonly connector: string;
  };
  /** Model used by the deployed coding subagent; defaults to the parent model. */
  readonly model?: AgentStaticModelDefinition;
  readonly reasoning?: AgentReasoningDefinition;
}

/** Deployed configuration with defaults applied. */
export interface ResolvedDeployedSelfModificationConfig extends DeployedSelfModificationConfig {
  readonly directory: string;
  readonly baseBranch: string;
}

/** GitHub user and organization names allow only alphanumerics and single hyphens. */
export function isGitHubOwner(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/u.test(value);
}

export function isGitHubRepositoryName(value: string): boolean {
  return (
    /^[A-Za-z0-9_.-]+$/u.test(value) && value !== "." && value !== ".." && !value.startsWith("-")
  );
}

export function isRepositoryRelativeDirectory(value: string): boolean {
  return (
    value === "." ||
    (value.length > 0 &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."))
  );
}

export function isBranchName(value: string): boolean {
  return isValidGitRef(value) && !value.startsWith("refs/");
}

function isGitHubRepository(value: string): boolean {
  const [owner, name, ...rest] = value.split("/");
  return (
    rest.length === 0 &&
    owner !== undefined &&
    name !== undefined &&
    isGitHubOwner(owner) &&
    isGitHubRepositoryName(name)
  );
}

export const deployedSelfModificationConfigSchema = z
  .object({
    model: z
      .custom<AgentStaticModelDefinition>(
        (value) => typeof value === "string" || isRuntimeLanguageModel(value),
      )
      .optional(),
    reasoning: z.custom<AgentReasoningDefinition>(isAgentReasoningDefinition).optional(),
    authorize: z.custom<DeployedSelfModificationAuthorization>(
      (value) => typeof value === "function",
      "Deployed self-modification authorize must be a function.",
    ),
    directory: z
      .string()
      .refine(
        isRepositoryRelativeDirectory,
        "Deployed self-modification directory must be a safe repository-relative path.",
      )
      .default("."),
    baseBranch: z
      .string()
      .refine(
        isBranchName,
        "Deployed self-modification baseBranch must be a valid branch name, not a full Git ref.",
      )
      .default("main"),
    github: z
      .object({
        repository: z
          .string()
          .refine(
            isGitHubRepository,
            "Deployed self-modification github.repository must use owner/repo form.",
          ),
        connector: z.string().min(1),
      })
      .strict(),
  })
  .strict();
