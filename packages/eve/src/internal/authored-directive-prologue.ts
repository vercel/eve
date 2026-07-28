import { parseWithNitroRolldownAst } from "#internal/bundler/nitro-rolldown.js";

const UNSUPPORTED_WORKFLOW_DIRECTIVES = new Set(["use step", "use workflow"]);

interface DirectiveStatement {
  readonly directive?: unknown;
}

interface Program {
  readonly body?: unknown;
}

export async function assertNoWorkflowDirectivePrologue(input: {
  readonly filePath: string;
  readonly source: string;
}): Promise<void> {
  const program = (await parseWithNitroRolldownAst(input.filePath, input.source)) as Program;

  if (!Array.isArray(program.body)) {
    throw new Error(`Failed to parse authored module "${input.filePath}".`);
  }

  for (const statement of program.body as DirectiveStatement[]) {
    if (typeof statement.directive !== "string") {
      break;
    }

    if (UNSUPPORTED_WORKFLOW_DIRECTIVES.has(statement.directive)) {
      throw new Error(
        `Authored module "${input.filePath}" contains an actual "${statement.directive}" directive. ` +
          "Workflow directives are reserved for eve-generated workflow entrypoints.",
      );
    }
  }
}
