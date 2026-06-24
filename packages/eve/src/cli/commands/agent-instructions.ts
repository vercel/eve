import { readFileSync } from "node:fs";

// The two coding-agent prompts are one onboarding flow in two phases, composed
// from the section files in `agent-prompt/`. The setup guide runs before
// anything is scaffolded (a bare `eve init`); the handoff runs once a project
// exists (after `eve init <name>`, or when seeding a REPL). They share the
// `collect-intent`, `vercel-connect`, and `build-and-verify` sections verbatim,
// so guidance authored once reaches both. `{{devCommand}}` is rendered per
// caller; `{{workingDirectory}}` is post-scaffold only and lives in the handoff
// intro. The shared sections use paths relative to the project directory so the
// setup guide, which has no working directory yet, can reuse them unchanged.
// Exported so `agent-instructions.test.ts` can assert these lists name exactly
// the files in `agent-prompt/`, which is what keeps them from drifting.
/** Ordered `agent-prompt/` sections composed into the pre-scaffold setup guide. */
export const SETUP_SECTIONS = [
  "intro-setup.md",
  "collect-intent.md",
  "vercel-connect.md",
  "scaffold.md",
  "build-and-verify.md",
] as const;

/** Ordered `agent-prompt/` sections composed into the post-scaffold handoff. */
export const HANDOFF_SECTIONS = [
  "intro-handoff.md",
  "collect-intent.md",
  "vercel-connect.md",
  "build-and-verify.md",
] as const;

function compose(
  sections: readonly string[],
  options: { devCommand: string; workingDirectory?: string },
): string {
  const prompt = sections
    .map((section) =>
      readFileSync(new URL(`./agent-prompt/${section}`, import.meta.url), "utf8").trim(),
    )
    .join("\n\n")
    .replaceAll("{{devCommand}}", () => options.devCommand);
  const { workingDirectory } = options;
  if (workingDirectory === undefined) {
    return prompt;
  }
  return prompt.replaceAll("{{workingDirectory}}", () => workingDirectory);
}

/**
 * The pre-scaffold setup guide, shown when a coding agent runs a bare
 * `eve init`. It scaffolds from scratch, so it renders with the universal
 * `npx eve dev` rather than a launcher-specific command.
 */
export function initAgentInstructions(): string {
  return compose(SETUP_SECTIONS, { devCommand: "npx eve dev" });
}

/** The post-scaffold handoff printed after a coding agent runs `eve init <name>`. */
export function initAgentDevHandoff(options: { projectPath: string; devCommand: string }): string {
  return compose(HANDOFF_SECTIONS, {
    devCommand: options.devCommand,
    workingDirectory: options.projectPath,
  });
}

/** The initial prompt for a coding-agent REPL opened inside the scaffolded project. */
export function initAgentReplPrompt(options: { devCommand: string }): string {
  return compose(HANDOFF_SECTIONS, {
    devCommand: options.devCommand,
    workingDirectory: ".",
  });
}
