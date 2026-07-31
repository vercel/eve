import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

/**
 * Scenario-tier descriptor exercising the per-sandbox workspace-folder
 * convention: `agent/sandbox/workspace/**` contents are materialized into
 * `/workspace/**` inside the sandbox at runtime.
 */
export const SANDBOX_WORKSPACES_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/sandbox/sandbox.ts": `import { DefaultSandbox, defineSandbox } from "eve/sandbox";

export const template = DefaultSandbox.template();

export default defineSandbox(() => template.create());
`,
    "agent/sandbox/workspace/notes.md": `# repo-shell notes

Authored workspace mounted into the repo-shell sandbox.
`,
    "agent/instructions.md": `You are a fixture used to exercise per-sandbox workspace folders.
`,
  },
  name: "sandbox-workspaces",
};
