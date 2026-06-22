import { readFileSync } from "node:fs";

function readTemplate(fileName: string): string {
  return readFileSync(new URL(fileName, import.meta.url), "utf8").trim();
}

// The two coding-agent prompts are one onboarding flow in two phases.
// `init-agent-instructions.md` runs before anything is scaffolded, on a bare
// `eve init`. `init-agent-handoff.md` runs once a project exists, after
// `eve init <name>` or when seeding a REPL. Both share the same headings
// (## Collect intent, ## Build it out, then verify) and the `{{devCommand}}`
// placeholder, and both render through this one path so it stays identical.
// `{{workingDirectory}}` only exists after scaffolding, so it is optional.
function renderAgentPrompt(
  templateFile: string,
  options: { devCommand: string; workingDirectory?: string },
): string {
  let prompt = readTemplate(templateFile).replaceAll("{{devCommand}}", () => options.devCommand);
  const { workingDirectory } = options;
  if (workingDirectory !== undefined) {
    prompt = prompt.replaceAll("{{workingDirectory}}", () => workingDirectory);
  }
  return prompt;
}

/**
 * The pre-scaffold setup guide, shown when a coding agent runs a bare
 * `eve init`. It scaffolds from scratch, so it renders with the universal
 * `npx eve dev` rather than a launcher-specific command.
 */
export function initAgentInstructions(): string {
  return renderAgentPrompt("./init-agent-instructions.md", { devCommand: "npx eve dev" });
}

/** The post-scaffold handoff printed after a coding agent runs `eve init <name>`. */
export function initAgentDevHandoff(options: { projectPath: string; devCommand: string }): string {
  return renderAgentPrompt("./init-agent-handoff.md", {
    devCommand: options.devCommand,
    workingDirectory: options.projectPath,
  });
}

/** The initial prompt for a coding-agent REPL opened inside the scaffolded project. */
export function initAgentReplPrompt(options: { devCommand: string }): string {
  return renderAgentPrompt("./init-agent-handoff.md", {
    devCommand: options.devCommand,
    workingDirectory: ".",
  });
}
