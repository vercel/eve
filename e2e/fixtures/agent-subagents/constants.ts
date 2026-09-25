export const WORKSPACE_LOOKUP_MESSAGE = [
  "Call read-workspace-label to look up the workspace name for the current caller.",
  "Make a fresh lookup: earlier answers in this session may belong to a different caller.",
  "Report the returned name, or explain if access is denied.",
].join(" ");
export const WORKSPACE_FORWARDING_MARKER = "Shared workspace membership check.";

export const MODEL_CHOICE_SCENARIO =
  "MODEL-CHOICE Ask report-writer to summarize Alice's weekly update using openai/gpt-5.4.";
export const MODEL_CHOICE_SELECTED = "openai/gpt-5.4";

export const SCHEDULED_REMOTE_ROOT_SCENARIO =
  "SCHEDULED-REMOTE-ROOT Ask remote-loopback to prepare Alice's scheduled report.";
export const SCHEDULED_REMOTE_CHILD_SCENARIO =
  "SCHEDULED-REMOTE-CHILD Return exactly SCHEDULED-REMOTE-CHILD-RESULT.";
