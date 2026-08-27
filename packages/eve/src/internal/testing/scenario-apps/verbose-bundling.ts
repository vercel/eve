import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

/**
 * Scenario-tier descriptor exercising module bundling diagnostics — path
 * aliases (`@/`, `@/lib/*`) and CommonJS interop (`snowflake-sdk`). Used by
 * compile tests and e2e deployment tests.
 */
export const VERBOSE_BUNDLING_DESCRIPTOR: ScenarioAppDescriptor = {
  dependencies: {
    "snowflake-sdk": "^2.0.0",
    zod: "^4.3.6",
  },
  files: {
    ".gitignore": `.vercel
`,
    "agent/agent.ts": `import { defineAgent } from "eve";

export default defineAgent({
  build: {
    // These packages execute CommonJS/node-specific startup paths that do not
    // survive Nitro's hosted ESM bundling. Keep them external in Vercel output.
    externalDependencies: ["snowflake-sdk", "typescript"],
  },
  model: "openai/gpt-5.4-mini",
});
`,
    "agent/alias-root/shared/alias-route.ts": `export const rootAliasRoute = "@/shared/alias-route.ts";
`,
    "agent/channels/eve.ts": `import { none } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({ auth: none() });
`,
    "agent/lib/alias/lib-route.ts": `export const libAliasRoute = "@/lib/alias/lib-route.ts";
`,
    "agent/instructions.md": `You are a bundling diagnostics assistant. Use local tools and return exact, structured results.
`,
    "agent/tools/check_alias_paths.ts": `import { defineTool } from "eve/tools";
import { libAliasRoute } from "@/lib/alias/lib-route.ts";
import { rootAliasRoute } from "@/shared/alias-route.ts";

export default defineTool({
  description: "Return alias path markers from @/ and @/lib/ imports.",
  async execute() {
    return {
      libAliasRoute,
      rootAliasRoute,
    };
  },
});
`,
    "agent/tools/inspect_snowflake_module.ts": `import { defineTool } from "eve/tools";
import * as snowflake from "snowflake-sdk";
import { z } from "zod";

export default defineTool({
  description: "Return the exported keys from the snowflake-sdk module namespace import.",
  inputSchema: z.object({}).strict(),
  async execute() {
    const keys = Object.keys(snowflake).sort((left, right) => left.localeCompare(right));

    return {
      keyCount: keys.length,
      keys,
    };
  },
});
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
    "rootDir": ".",
    "baseUrl": ".",
    "paths": {
      "@/lib/*": ["./agent/lib/*"],
      "@/*": ["./agent/alias-root/*"]
    }
  },
  "include": ["agent/**/*"],
  "exclude": ["node_modules", "dist", "build", ".turbo", ".vercel"]
}
`,
  },
  installDependencies: true,
  name: "verbose-bundling",
};
