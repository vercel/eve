import { readFileSync } from "node:fs";

function readTemplate(fileName: string): string {
  return readFileSync(new URL(fileName, import.meta.url), "utf8").trim();
}

/** The launching-agent setup guide, read verbatim from its template. */
export function initAgentInstructions(): string {
  return readTemplate("./init-agent-instructions.md");
}

export function initAgentDevHandoff(options: { projectPath: string; devCommand: string }): string {
  return readTemplate("./init-agent-handoff.md")
    .replaceAll("{{projectPath}}", () => options.projectPath)
    .replaceAll("{{devCommand}}", () => options.devCommand);
}
