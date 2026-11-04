export const WORKSPACE_LOOKUP_MESSAGE = [
  "Call read-workspace-label to look up the workspace name for the current caller.",
  "Make a fresh lookup: earlier answers in this session may belong to a different caller.",
  "Report the returned name, or explain if access is denied.",
].join(" ");
export const WORKSPACE_FORWARDING_MARKER = "Shared workspace membership check.";

export const MODEL_AGENT_SELECTED_MODEL = "openai/gpt-6.1-sol";

/** The directive words of the notebook scripts, one per parent turn. */
export const NOTEBOOK_DIRECTIVES = [
  "NOTEBOOK-REMEMBER",
  "NOTEBOOK-CHECK",
  "NOTEBOOK-REVIEW",
  "NOTEBOOK-RESTART",
  "NOTEBOOK-RECALL",
  "NOTEBOOK-CORRECT",
] as const;
export type NotebookDirective = (typeof NOTEBOOK_DIRECTIVES)[number];
/** Starts every message the parent sends a notebook keeper. */
export const NOTEBOOK_ENTRY = "NOTEBOOK-ENTRY";
/** The name Alice gives the keeper, explicitly supplied again when starting a replacement task. */
export const NOTEBOOK_NAME = "Harbor Lumen 4482";
/** The parent's correction, sent by `taskId` while the keeper measures the pier. */
export const NOTEBOOK_CORRECTION = `${NOTEBOOK_ENTRY} Correction: Alice meant the south pier, not the north pier.`;
/** What a keeper reports once it measures the pier Alice meant after her correction. */
export const CORRECTED_MEASUREMENT = "NOTEBOOK-DEPTH south pier 4.2 m";

/** Starts Alice's survey request, which the parent delegates to one survey-worker task. */
export const SURVEY_DIRECTIVE = "SURVEY-DELEGATE";
/** Starts Alice's survey request, which the parent runs through the survey-through-tool workflow tool. */
export const SURVEY_TOOL_DIRECTIVE = "SURVEY-TOOL";
/** What survey-worker reports for its one model call: more than the parent's default 40M input budget. */
export const SURVEY_WORKER_INPUT_TOKENS = 50_000_000;

/** Starts Alice's request to the tenant-remote agent, and Bob's continuation of it. */
export const TENANT_REMOTE_DIRECTIVE = "TENANT-REMOTE";
/** What the parent sends the tenant-remote child, which reports who it runs as. */
export const TENANT_WHOAMI_MESSAGE = "TENANT-WHOAMI Run the whoami tool and report its marker.";
export type Tenant = "acme" | "globex";
/** The bearer each tenant's remote calls carry; the eve channel runs each as its tenant. */
export const TENANT_AUTHORIZATIONS: Readonly<Record<Tenant, string>> = {
  acme: "Bearer e2e-tenant-acme",
  globex: "Bearer e2e-tenant-globex",
};
