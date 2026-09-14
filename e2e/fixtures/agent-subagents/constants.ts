export const WORKSPACE_LOOKUP_MESSAGE = [
  "Call read-workspace-label to look up the workspace name for the current caller.",
  "Make a fresh lookup: earlier answers in this session may belong to a different caller.",
  "Report the returned name, or explain if access is denied.",
].join(" ");
export const WORKSPACE_FORWARDING_MARKER = "Shared workspace membership check.";

export const NESTED_COMPLETION_PARENT_SCENARIO =
  "Alice asks the remote-loopback agent to have its gated-reviewer review a launch draft.";
export const NESTED_COMPLETION_CHILD_SCENARIO =
  "Ask gated-reviewer to review Alice's launch draft, acknowledge while it works, then return its exact result.";

export const SCHEDULED_REMOTE_ROOT_SCENARIO =
  "SCHEDULED-REMOTE-ROOT Ask remote-loopback to prepare Alice's scheduled report.";
export const SCHEDULED_REMOTE_CHILD_SCENARIO =
  "SCHEDULED-REMOTE-CHILD Return exactly SCHEDULED-REMOTE-CHILD-RESULT.";
