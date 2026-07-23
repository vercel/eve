import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

/**
 * Scenario-tier descriptor exercising every framework-tool override pattern:
 * wrap (`bash`), replace (`todo`), and disable (`agent`, `web_fetch`, `web_search`).
 * The compile pipeline must preserve the override semantics end-to-end.
 */
export const TOOL_OVERRIDES_DESCRIPTOR: ScenarioAppDescriptor = {
  dependencies: {
    zod: "^4.3.6",
  },
  files: {
    ".gitignore": `.vercel
`,
    "agent/agent.ts": `import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.4-mini",
});
`,
    "agent/instructions.md": `A fixture agent that exercises every framework-tool override pattern: wrap, disable, and replace.
`,
    "agent/tools/agent.ts": `import { disableTool } from "eve/tools";

// Removes the root-only recursive self-copy tool.
export default disableTool();
`,
    "agent/tools/bash.ts": `import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { bash } from "eve/tools/defaults";

// Wraps the framework \`bash\` tool: spread the default and replace \`execute\`
// with a thin pre-hook that delegates to the original. The framework's
// \`name\`, \`description\`, and \`inputSchema\` are inherited via the spread.
export default defineTool({
  ...bash,
  description: "Run a vetted shell command in the project sandbox.",
  approval: always(),
  async execute(input, ctx) {
    return bash.execute(input, ctx);
  },
});
`,
    "agent/tools/todo.ts": `import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

interface NoteListState {
  readonly notes: readonly string[];
}

const noteList = defineState<NoteListState>("tool-overrides.notes", () => ({ notes: [] }));

export default defineTool({
  description: "Append a note or read the running list of notes.",
  inputSchema: z.object({
    note: z.string().optional(),
  }),
  async execute(input) {
    if (typeof input.note === "string" && input.note.length > 0) {
      noteList.update((current) => ({
        notes: [...current.notes, input.note],
      }));
    }
    return noteList.get();
  },
});
`,
    "agent/tools/web_fetch.ts": `import { disableTool } from "eve/tools";

// Removes the framework \`web_fetch\` tool from this agent's resolved tool set.
// The compiler reads the filename slug ("web_fetch") to determine which
// framework default this sentinel disables.
export default disableTool();
`,
    "agent/tools/web_search.ts": `import { disableTool } from "eve/tools";

// Removes the framework \`web_search\` tool from this agent's resolved tool set.
// The compiler reads the filename slug ("web_search") to determine which
// framework default this sentinel disables.
export default disableTool();
`,
    "tsconfig.json": `{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "erasableSyntaxOnly": true,
    "strict": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "useUnknownInCatchVariables": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": ["node"],
    "allowJs": true,
    "rootDir": "."
  },
  "include": ["agent/**/*"],
  "exclude": ["node_modules", "dist", "build", ".turbo", ".vercel"]
}
`,
  },
  installDependencies: true,
  name: "tool-overrides",
};
