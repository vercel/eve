import { relative } from "node:path";

import pc from "picocolors";

import { detectPackageManager } from "../package-manager.js";
import type { Prompter } from "../prompter.js";
import { requireProjectPath, type SetupState } from "../state.js";
import type { SetupBox } from "../step.js";

/**
 * The path the user types from their shell: relative when the project is under
 * the cwd, absolute otherwise (e.g. `--target-dir` pointing elsewhere).
 */
function cdTarget(projectPath: string): string {
  const fromCwd = relative(process.cwd(), projectPath);
  return fromCwd.length === 0 || fromCwd.startsWith("..") ? projectPath : fromCwd;
}

export interface OneShotNextStepsOptions {
  /** Reports the next-steps note. The box never prompts. */
  prompter: Prompter;
  /** Test seam for the package manager that owns generated commands. */
  detectPackageManager?: typeof detectPackageManager;
}

/** One bold command line, optionally trailed by a dimmed comment. */
function step(command: string, comment?: string): string {
  return `  ${pc.bold(command)}${comment === undefined ? "" : ` ${pc.dim(`# ${comment}`)}`}`;
}

/**
 * THE ONE-SHOT EPILOGUE BOX: a one-shot run skips every post-scaffold box, so
 * it ends here with exactly the commands that take the scaffold to a running
 * agent. No project or team was resolved, so `vercel link` is the credential
 * step: a logged-in CLI plus the link lets the runtime mint an AI Gateway
 * token, and pasting a key into `.env.local` is the manual alternative.
 */
export function oneShotNextSteps(
  options: OneShotNextStepsOptions,
): SetupBox<SetupState, null, null> {
  return {
    id: "one-shot-next-steps",

    shouldRun(state) {
      return state.setupMode === "one-shot";
    },

    async gather(): Promise<null> {
      return null;
    },

    async perform({ state }): Promise<null> {
      const projectPath = requireProjectPath(state);
      const packageManager = await (options.detectPackageManager ?? detectPackageManager)(
        projectPath,
      );
      const lines = [
        "Your agent is scaffolded but not deployed or connected yet.",
        ...(state.projectPath.inPlace ? [] : [step(`cd ${cdTarget(projectPath)}`)]),
        step(`${packageManager.kind} install`),
        step("vercel link", "or set AI_GATEWAY_API_KEY in .env.local manually"),
        step("eve dev"),
      ];
      options.prompter.note(lines.join("\n"), "Next steps", { tone: "success" });
      return null;
    },

    apply(state) {
      return state;
    },
  };
}
