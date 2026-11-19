import type { EveProjectContext } from "#internal/project-context.js";
import { findEveProjectContext } from "#internal/project-context.js";
import { isEveProject } from "#setup/scaffold/index.js";

export const NOT_AN_AGENT_MESSAGE =
  "No eve agent in this directory. Run `eve init <name>`, then run this command from inside the new project.";

interface ProjectCommandLogger {
  error(message: string): void;
}

export async function validateWorkspaceProjectCommand(input: {
  readonly appRoot: string;
  readonly isEveProject?: typeof isEveProject;
  readonly logger: ProjectCommandLogger;
  readonly workspaceMemberMessage: (
    workspace: Extract<EveProjectContext, { kind: "workspace" }>["workspace"],
  ) => string;
}): Promise<boolean> {
  const projectContext = await findEveProjectContext(input.appRoot);
  if (projectContext?.kind === "workspace-member") {
    input.logger.error(input.workspaceMemberMessage(projectContext.workspace));
    process.exitCode = 1;
    return false;
  }
  if (
    projectContext === undefined ||
    (projectContext.kind === "standalone" &&
      !(await (input.isEveProject ?? isEveProject)(input.appRoot)))
  ) {
    input.logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return false;
  }
  return true;
}

export function hasInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
