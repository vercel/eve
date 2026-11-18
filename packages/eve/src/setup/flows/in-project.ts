import { basename } from "node:path";

import type { ProjectResolution } from "../project-resolution.js";
import type { Prompter } from "../prompter.js";
import { createDefaultSetupState, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";

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

export function prompterSink(prompter: Prompter): OutputSink {
  return { write: (line) => prompter.log.message(line) };
}
