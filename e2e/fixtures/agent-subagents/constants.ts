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
  "NOTEBOOK-REVIEW",
  "NOTEBOOK-RECALL",
  "NOTEBOOK-CORRECT",
] as const;
export type NotebookDirective = (typeof NOTEBOOK_DIRECTIVES)[number];
/** Starts every message the parent sends a notebook keeper. */
export const NOTEBOOK_ENTRY = "NOTEBOOK-ENTRY";
/** The fact a keeper must still know after its task is cancelled and continued. */
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

/** Starts the fan-out: the parent starts lease-worker-a and lease-worker-b in one step. */
export const LEASE_DIRECTIVE = "LEASE-FANOUT";
/** New input per lease-worker page: three pages cross the default 40M window. */
export const LEASE_STEP_INPUT_TOKENS = 15_000_000;
/** How long worker b's second page takes: longer than worker a's prompt takes to reach the eval and be approved. */
export const LEASE_SLOW_PAGE_MS = 10_000;
/** The same fan-out with no slow page, so both workers ask and wait on their prompts. */
export const LEASE_PARKED_DIRECTIVE = "LEASE-PARKED";
