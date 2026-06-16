import { basename } from "node:path";

import type { ProjectResolution } from "../project-resolution.js";
import type { Prompter } from "../prompter.js";
import { createDefaultSetupState, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";

/**
 * Seeds the in-project {@link SetupState} the link and deploy flows start
 * from: the detected (or deliberately unresolved) link, the directory basename
 * as the agent name (it labels resolve-provisioning's "create a new project
 * named X" row), and the resolved in-place project path. The channels flow
 * seeds its own state instead — it must keep the default empty agent name so
 * the Slack connector slug falls back to the package.json name, exactly like
 * `eve channels add`.
 */
export function inProjectSetupState(
  appRoot: string,
  project: ProjectResolution,
  seed?: Partial<SetupState>,
): SetupState {
  return {
    ...createDefaultSetupState(),
    project,
    agentName: basename(appRoot),
    projectPath: { kind: "resolved", inPlace: true, path: appRoot },
    ...seed,
  };
}

/** Routes runner sink output through the prompter's log. */
export function prompterSink(prompter: Prompter): OutputSink {
  return { write: (line) => prompter.log.message(line) };
}
