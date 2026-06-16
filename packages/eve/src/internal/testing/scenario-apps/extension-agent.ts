import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

/**
 * Scenario-tier descriptor that exercises authored modules using mixed file
 * extensions (`.cjs`, `.cts`, `.mjs`, `.mts`, `.js`). The compile pipeline
 * must tolerate this variety without requiring a specific extension.
 */
export const EXTENSION_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.cjs": `module.exports = {
  model: "openai/gpt-5.4",
};
`,
    "agent/lib/weather/bridge.js": `export const TOOL_MIDDLE = "using lib extension imports";
`,
    "agent/lib/weather/prefix.cjs": `module.exports = {
  TOOL_PREFIX: "Get weather details",
};
`,
    "agent/lib/weather/suffix.mts": `export const TOOL_SUFFIX = "through mixed extension loading";
`,
    "agent/lib/weather/tail.mjs": `export const TOOL_TAIL = "across cjs/js/mts/mjs modules.";
`,
    "agent/sandbox/sandbox.cjs": `module.exports = {
  async onSession({ use }) {
    const sandbox = await use();
    await sandbox.run({ command: "mkdir -p .extension-fixture" });
  },
};
`,
    "agent/schedules/nightly.cts": `export default {
  cron: "0 0 * * *",
  markdown: "Run the nightly extension fixture schedule.",
};
`,
    "agent/skills/handoff.mts": `export default {
  description: "Hand off the task to the next specialist.",
  markdown: "Use this skill when routing tasks across specialized agents.",
};
`,
    "agent/instructions.md": `You are an extension fixture agent.
`,
    "agent/tools/get_weather.mts": `import { TOOL_MIDDLE } from "../lib/weather/bridge.js";
import prefix from "../lib/weather/prefix.cjs";
import { TOOL_SUFFIX } from "../lib/weather/suffix.mts";
import { TOOL_TAIL } from "../lib/weather/tail.mjs";

const TOOL_DESCRIPTION = \`\${prefix.TOOL_PREFIX} \${TOOL_MIDDLE} \${TOOL_SUFFIX} \${TOOL_TAIL}\`;

export default {
  description: TOOL_DESCRIPTION,
  async execute(input: unknown) {
    return input;
  },
};
`,
  },
  name: "extension-agent",
};
