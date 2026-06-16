import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

/**
 * Scenario-tier descriptor exercising sandbox-bundling diagnostics. Used by
 * the Vercel e2e deployment tests to verify the hosted bundle loads cleanly:
 * the local sandbox backend (Docker + optional just-bash engines) must be
 * pruned and the vendored `@vercel/sandbox` chunk must resolve.
 */
export const SANDBOX_BUNDLING_DESCRIPTOR: ScenarioAppDescriptor = {
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
    "agent/channels/eve.ts": `import { none } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({ auth: none() });
`,
    "agent/instructions.md": `You are a sandbox bundling diagnostics assistant. Use the framework-provided bash tool to inspect the deployed environment.
`,
    "tsconfig.json": `{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
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
  name: "sandbox-bundling",
};
