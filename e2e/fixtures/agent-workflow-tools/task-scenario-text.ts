// Text the mock models write while a turn waits on a task, shared with the
// evals that check where it appears.

/** The root agent's text before its turn waits on `stage_deploy`. */
export const STAGE_INTERIM_MESSAGE = "Staging api now; I'll report back with the digest.";

/** The root agent's text before its turn waits on the `workflow-stager` agent. */
export const DELEGATE_INTERIM_MESSAGE = "Asked workflow-stager to stage api; I'll report back.";

/** The `workflow-stager` child's text before its own turn waits on its staging task. */
export const STAGER_INTERIM_MESSAGE = "Staging api for the parent now.";
