export const WORKSPACE_LOOKUP_MESSAGE = [
  "Call read-workspace-label to look up the workspace name for the current caller.",
  "Make a fresh lookup: earlier answers in this session may belong to a different caller.",
  "Report the returned name, or explain if access is denied.",
].join(" ");
export const WORKSPACE_FORWARDING_MARKER = "Shared workspace membership check.";

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
