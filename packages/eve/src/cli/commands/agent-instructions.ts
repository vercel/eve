import { readFileSync } from "node:fs";

function readTemplate(fileName: string): string {
  return readFileSync(new URL(fileName, import.meta.url), "utf8").trim();
}

export function initAgentInstructions(options: { initCommand: string }): string {
  return readTemplate("./init-agent-instructions.md").replace(
    "{{initCommand}}",
    () => options.initCommand,
  );
}

export function initAgentDevHandoff(options: { projectPath: string; devCommand: string }): string {
  return readTemplate("./init-agent-handoff.md")
    .replaceAll("{{projectPath}}", () => options.projectPath)
    .replace("{{devCommand}}", () => options.devCommand);
}
