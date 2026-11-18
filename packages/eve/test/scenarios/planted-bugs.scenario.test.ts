import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildApplicationInfoJson } from "../../src/cli/commands/info.js";
import { useTemporaryAppRoots } from "../../src/internal/testing/use-temporary-app-roots.js";
import { inspectApplication } from "../../src/services/inspect-application.js";

const createAppRoot = useTemporaryAppRoots();
const ZOD_PACKAGE_ROOT = dirname(createRequire(import.meta.url).resolve("zod/package.json"));
const UNLISTED_MODEL_ID = ["openai", "gpt-nonexistent-9"].join("/");

const tool = (fields: string, imports = "") => `import { defineTool } from "eve/tools";
import { z } from "zod";
${imports}
export default defineTool({
${fields}
  async execute(input) {
    return { input };
  },
});
`;

const researchBrief = (
  body: string,
  imports = "",
) => `import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
${imports}
export default defineWorkflowTool({
  description: "Ask the researcher for a brief.",
  inputSchema: z.object({ topic: z.string() }),
  async execute({ topic }, ctx) {
    "use workflow";
${body}
  },
});
`;

const northstar = (approval: string) => `import { defineOpenAPIConnection } from "eve/connections";

export default defineOpenAPIConnection({
  baseUrl: "https://northstar.example.com",
  description: "Northstar purchasing.",
  spec: { openapi: "3.0.0", info: { title: "Northstar", version: "1.0.0" }, paths: { "/orders": { post: { operationId: "createPurchaseOrder", responses: { 200: { description: "ok" } } } }, "/orders/{id}": { delete: { operationId: "deleteOrder", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok" } } } } } },
  operations: { allow: ["createPurchaseOrder"] },
  approval: ({ toolName }) => (${approval} ? "user-approval" : "not-applicable"),
});
`;

const BASELINE: Readonly<Record<string, string>> = {
  "agent/agent.ts": `import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n`,
  "agent/instructions.md": "Help Alice check the weather.\n",
  "agent/skills/get-weather.md":
    "---\nname: get-weather\ndescription: Check the weather for a city.\n---\nCall get_weather.\n",
  "agent/tools/get_weather.ts": tool(
    `  description: "Get the weather for a city.",\n  inputSchema: z.object({ city: z.string() }),`,
  ),
  "agent/tools/research_brief.ts": researchBrief(
    '    const response = await ctx.agent("researcher").send(`Research ${topic}`);\n    return { brief: await response.result() };',
  ),
  "agent/connections/northstar.ts": northstar('toolName === "northstar__createPurchaseOrder"'),
  "agent/subagents/researcher/agent.ts": `import { defineAgent } from "eve";\nexport default defineAgent({ description: "Research a topic.", model: "openai/gpt-5.4", tool: false });\n`,
  "agent/subagents/researcher/tools/cite_source.ts": tool(
    `  description: "Find a source.",\n  inputSchema: z.object({ query: z.string() }),`,
  ),
};

type Stage = "eve info" | "build" | "first turn" | "never";

interface PlantedBug {
  readonly id: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly moves?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly caughtAt: Stage;
  readonly severity?: "error" | "warning";
  readonly code?: string;
  readonly message?: string;
}

const PLANTED_BUGS: readonly PlantedBug[] = [
  {
    id: "tool inputSchema is a field map, not JSON Schema",
    files: {
      "agent/tools/get_weather.ts": tool(
        `  description: "Get the weather.",\n  inputSchema: { city: "string" },`,
      ),
    },
    caughtAt: "eve info",
    code: "compile/tool-input-schema-invalid",
    message: "its root has no type",
  },
  {
    id: "tool inputSchema root is a string",
    files: {
      "agent/tools/get_weather.ts": tool(
        `  description: "Get the weather.",\n  inputSchema: z.string(),`,
      ),
    },
    caughtAt: "eve info",
    code: "compile/tool-input-schema-invalid",
    message: 'its root has type "string"',
  },
  {
    id: "tool inputSchema root is a JSON Schema union",
    files: {
      "agent/tools/get_weather.ts": tool(
        `  description: "Get the weather.",\n  inputSchema: { anyOf: [{ type: "object", properties: { city: { type: "string" } } }, { type: "object", properties: { zip: { type: "string" } } }] },`,
      ),
    },
    caughtAt: "eve info",
    code: "compile/tool-input-schema-invalid",
    message: 'its root is "anyOf"',
  },
  {
    id: "tool inputSchema uses an unknown JSON Schema type",
    files: {
      "agent/tools/get_weather.ts": tool(
        `  description: "Get the weather.",\n  inputSchema: { type: "object", properties: { city: { type: "string", enum: ["Paris", "Tokyo"] }, note: { type: "text" } }, required: ["city"] },`,
      ),
    },
    caughtAt: "eve info",
    code: "compile/tool-input-schema-invalid",
    message: 'unsupported type "text", so eve can\'t validate',
  },
  {
    id: "tool inputSchema cannot be represented as JSON Schema",
    files: {
      "agent/tools/get_weather.ts": tool(
        `  description: "Get the weather.",\n  inputSchema: z.object({ when: z.date() }),`,
      ),
    },
    caughtAt: "eve info",
    message: "Date cannot be represented in JSON Schema",
  },
  {
    id: "tool has no description",
    files: {
      "agent/tools/get_weather.ts": tool(`  inputSchema: z.object({ city: z.string() }),`),
    },
    caughtAt: "eve info",
    message: 'Expected "description" to be a string',
  },
  {
    id: "tool uses a named export",
    files: {
      "agent/tools/get_weather.ts": tool(
        `  description: "Get the weather.",\n  inputSchema: z.object({ city: z.string() }),`,
      ).replace("export default defineTool", "export const getWeather = defineTool"),
    },
    caughtAt: "eve info",
    message: '"tools/get_weather.ts" has no default export; it exports "getWeather"',
  },
  {
    id: "tool exports a plain function",
    files: {
      "agent/tools/get_weather.ts":
        "export default async function getWeather({ city }: { city: string }) {\n  return { city };\n}\n",
    },
    caughtAt: "eve info",
    message: 'Failed to execute the tool export "default" from "tools/get_weather.ts"',
  },
  {
    id: "agent config uses a named export",
    files: {
      "agent/agent.ts": `import { defineAgent } from "eve";\nexport const agent = defineAgent({ model: "openai/gpt-5.4" });\n`,
    },
    caughtAt: "eve info",
    message: '"agent.ts" has no default export; it exports "agent"',
  },
  {
    id: "subagent has no description",
    files: {
      "agent/subagents/researcher/agent.ts": `import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4", tool: false });\n`,
    },
    caughtAt: "eve info",
    message: 'Subagent "subagents/researcher" must define a non-empty description.',
  },
  {
    id: "workflow tool is missing its directive",
    files: {
      "agent/tools/research_brief.ts": researchBrief(
        "    return { topic, agents: Object.keys(ctx.agents) };",
      ).replace('    "use workflow";\n', ""),
    },
    caughtAt: "eve info",
    message: "requires a compiled workflow executor",
  },
  {
    id: "tools/ directory is singular",
    moves: { "agent/tools/get_weather.ts": "agent/tool/get_weather.ts" },
    caughtAt: "eve info",
    severity: "warning",
    code: "discover/unsupported-directory",
    message: 'Did you mean "tools/"?',
  },
  {
    id: "subagents/ directory is singular",
    moves: { "agent/subagents": "agent/subagent" },
    caughtAt: "eve info",
    code: "compile/workflow-agent-target-unknown",
    message: 'calls ctx.agent("researcher"), but no agent by that name is available to it.',
  },
  {
    id: "instructions file is misnamed",
    moves: { "agent/instructions.md": "agent/instruction.md" },
    caughtAt: "eve info",
    code: "discover/required-instructions-missing",
  },
  {
    id: "agent config file is misnamed",
    moves: { "agent/agent.ts": "agent/agents.ts" },
    caughtAt: "first turn",
  },
  {
    id: "subagent config file is misnamed",
    moves: { "agent/subagents/researcher/agent.ts": "agent/subagents/researcher/index.ts" },
    caughtAt: "eve info",
    message: 'Expected one authored subagent config module at "agent.ts"',
  },
  {
    id: "tool file uses .tsx",
    moves: { "agent/tools/get_weather.ts": "agent/tools/get_weather.tsx" },
    caughtAt: "never",
  },
  {
    id: "tool filename has a space",
    moves: { "agent/tools/get_weather.ts": "agent/tools/get weather.ts" },
    caughtAt: "eve info",
    code: "discover/tool-name-invalid",
  },
  {
    id: "skill file has the wrong extension",
    moves: { "agent/skills/get-weather.md": "agent/skills/get-weather.txt" },
    caughtAt: "eve info",
    code: "discover/skill-entry-not-directory",
  },
  {
    id: "skill package has no SKILL.md",
    moves: { "agent/skills/get-weather.md": "agent/skills/get-weather/README.md" },
    caughtAt: "eve info",
    code: "discover/skill-markdown-missing",
  },
  {
    id: "two modules claim the same tool",
    files: {
      "agent/tools/get_weather.js": `export { default } from "./get_weather.ts";\n`,
    },
    caughtAt: "eve info",
    code: "discover/module-slot-collision",
  },
  {
    id: "tool and subagent share a name",
    files: {
      "agent/tools/researcher.ts": tool(
        `  description: "Research.",\n  inputSchema: z.object({ q: z.string() }),`,
      ),
    },
    caughtAt: "eve info",
    message: 'public name "researcher" is shared by tool and local agent',
  },
  {
    id: "workflow tool calls a misspelled subagent",
    files: {
      "agent/tools/research_brief.ts": researchBrief(
        "    const response = await ctx.agent(`reseacher`).send(topic);\n    return { brief: await response.result() };",
      ),
    },
    caughtAt: "eve info",
    code: "compile/workflow-agent-target-unknown",
    message: 'Did you mean "researcher"?',
  },
  {
    id: "subagent workflow tool calls an agent it cannot reach",
    files: {
      "agent/subagents/researcher/tools/ask_back.ts": researchBrief(
        '    const response = await ctx.agent("agent").send(topic);\n    return { brief: await response.result() };',
      ),
    },
    caughtAt: "eve info",
    code: "compile/workflow-agent-target-unknown",
    message: "This agent has no subagents or remote agents to call.",
  },
  {
    id: "subagent re-exports a tool path that does not exist",
    files: {
      "agent/subagents/researcher/tools/get_weather.ts": `export { default } from "../../../tools/get_wether";\n`,
    },
    caughtAt: "eve info",
    message: "Could not resolve '../../../tools/get_wether'",
  },
  {
    id: "subagent disables a misspelled built-in tool",
    files: {
      "agent/subagents/researcher/tools/web_serch.ts": `import { disableTool } from "eve/tools";\nexport default disableTool();\n`,
    },
    caughtAt: "eve info",
    message: "disables a slot with no lower-precedence source",
  },
  {
    id: "tool imports an uninstalled package",
    files: {
      "agent/tools/get_weather.ts": tool(
        `  description: "Get the weather.",\n  inputSchema: z.object({ city: z.string() }),`,
        'import { capitalize } from "lodash-es";\nvoid capitalize;',
      ),
    },
    caughtAt: "eve info",
    message: 'Cannot resolve package "lodash-es"',
  },
  {
    id: "subagent model id is not in the catalog",
    files: {
      "agent/subagents/researcher/agent.ts": `import { defineAgent } from "eve";\nexport default defineAgent({ description: "Research a topic.", model: ${JSON.stringify(UNLISTED_MODEL_ID)}, tool: false });\n`,
    },
    caughtAt: "eve info",
    message: `Model "${UNLISTED_MODEL_ID}" in "subagents/researcher/agent.ts" is not in the AI Gateway model catalog`,
  },
  {
    id: "workflow body calls a step-only context API",
    files: {
      "agent/tools/research_brief.ts": researchBrief(
        "    const sandbox = await (ctx as any).getSandbox();\n    return { topic, sandbox: typeof sandbox };",
      ),
    },
    caughtAt: "first turn",
  },
  {
    id: "connection approval compares an unprefixed tool name",
    files: {
      "agent/connections/northstar.ts": northstar('toolName === "createPurchaseOrder"'),
    },
    caughtAt: "eve info",
    code: "compile/approval-tool-name-unknown",
    message: 'Did you mean "northstar__createPurchaseOrder"?',
  },
  {
    id: "connection approval names an operation outside operations.allow",
    files: {
      "agent/connections/northstar.ts": northstar('toolName === "northstar__deleteOrder"'),
    },
    caughtAt: "eve info",
    code: "compile/approval-tool-name-unknown",
    message: 'operations.allow doesn\'t include "deleteOrder"',
  },
  {
    id: "build script runs tsc instead of eve build",
    scripts: { build: "tsc" },
    caughtAt: "eve info",
    severity: "warning",
    code: "project/build-script-skips-eve",
  },
  {
    id: "Next.js config is not wrapped in withEve",
    files: { "next.config.ts": "const nextConfig = {};\nexport default nextConfig;\n" },
    caughtAt: "eve info",
    severity: "warning",
    code: "project/next-config-missing-with-eve",
  },
  {
    id: "tool reads an env var that .env.example doesn't list",
    files: {
      ".env.example": "OPENAI_API_KEY=\n",
      "agent/tools/get_weather.ts": tool(
        `  description: "Get the weather.",\n  inputSchema: z.object({ city: z.string() }),`,
      ).replace(
        "return { input };",
        'if (!process.env.WEATHER_API_KEY) throw new Error("WEATHER_API_KEY is not set");\n    return { input, region: process.env.REGION ?? "us" };',
      ),
    },
    caughtAt: "first turn",
  },
  {
    id: "tools live in src/ instead of agent/",
    moves: { "agent/tools/get_weather.ts": "src/tools/get_weather.ts" },
    caughtAt: "eve info",
    severity: "warning",
    code: "project/agent-files-outside-agent-root",
    message: '"src/tools/"',
  },
  {
    id: "tool imports a helper that eve doesn't export",
    files: {
      "agent/tools/get_weather.ts": tool(
        `  description: "Get the weather.",\n  approval: sometimes(),\n  inputSchema: z.object({ city: z.string() }),`,
        'import { sometimes } from "eve/tools/approval";',
      ),
    },
    caughtAt: "eve info",
    message: "does not provide an export named 'sometimes'",
  },
  {
    id: "workflow body uses a Node.js builtin",
    files: {
      "agent/tools/research_brief.ts": researchBrief(
        '    return { topic, host: readFileSync("/etc/hostname", "utf8") };',
        'import { readFileSync } from "node:fs";',
      ),
    },
    caughtAt: "build",
  },
  {
    id: "workflow body calls the server-only Workflow API",
    files: {
      "agent/tools/research_brief.ts": researchBrief(
        '    return { topic, run: typeof getRun("missing") };',
        'import { getRun } from "eve/workflow/api";',
      ),
    },
    caughtAt: "build",
  },
  {
    id: "workflow body reads process.env",
    files: {
      "agent/tools/research_brief.ts": researchBrief(
        '    return { topic, region: process.env.REGION ?? "us" };',
      ),
    },
    caughtAt: "never",
  },
];

const CONTROLS: readonly { readonly id: string; readonly files?: Record<string, string> }[] = [
  { id: "the baseline agent" },
  {
    id: "a Zod root union of objects, which eve sends with type object",
    files: {
      "agent/tools/get_weather.ts": tool(
        `  description: "Get the weather.",\n  inputSchema: z.discriminatedUnion("by", [z.object({ by: z.literal("city"), city: z.string() }), z.object({ by: z.literal("zip"), zip: z.string() })]),`,
      ),
    },
  },
  {
    id: "a Next.js config wrapped in withEve",
    files: {
      "next.config.ts": 'import { withEve } from "eve/next";\nexport default withEve({});\n',
    },
  },
  {
    id: "a tool that imports server-only",
    files: {
      "agent/tools/get_weather.ts": tool(
        `  description: "Get the weather.",\n  inputSchema: z.object({ city: z.string() }),`,
        'import "server-only";',
      ),
    },
  },
];

async function inspectPlantedAgent(input: {
  readonly files?: Readonly<Record<string, string>>;
  readonly moves?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
}) {
  const { appRoot } = await createAppRoot("eve-planted-bug-", {
    files: BASELINE,
    packageName: "planted-bug-agent",
  });
  await symlink(ZOD_PACKAGE_ROOT, join(appRoot, "node_modules", "zod"), "junction");
  for (const [from, to] of Object.entries(input.moves ?? {})) {
    await mkdir(dirname(join(appRoot, to)), { recursive: true });
    await rename(join(appRoot, from), join(appRoot, to));
  }
  for (const [path, contents] of Object.entries(input.files ?? {})) {
    await mkdir(dirname(join(appRoot, path)), { recursive: true });
    await rm(join(appRoot, path), { force: true });
    await writeFile(join(appRoot, path), contents);
  }
  if (input.scripts !== undefined) {
    const packageJsonPath = join(appRoot, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as object;
    await writeFile(packageJsonPath, JSON.stringify({ ...packageJson, scripts: input.scripts }));
  }
  return buildApplicationInfoJson(await inspectApplication(appRoot));
}

describe("planted bugs", () => {
  it.each(CONTROLS)("eve info reports nothing for $id", async (control) => {
    const info = await inspectPlantedAgent(control);

    expect(info.status).toBe("ready");
    expect(info.diagnostics?.items).toEqual([]);
  });

  it.each(PLANTED_BUGS.filter((bug) => bug.caughtAt === "eve info"))(
    "eve info catches: $id",
    async (bug) => {
      const info = await inspectPlantedAgent(bug);
      const severity = bug.severity ?? "error";

      expect(info.diagnostics?.items).toContainEqual(
        expect.objectContaining({
          severity,
          ...(bug.code !== undefined && { code: bug.code }),
          ...(bug.message !== undefined && { message: expect.stringContaining(bug.message) }),
        }),
      );
      expect(info.status).toBe(severity === "error" ? "failed" : "ready");
    },
  );

  it.each(PLANTED_BUGS.filter((bug) => bug.caughtAt !== "eve info"))(
    "eve info does not catch yet ($caughtAt): $id",
    async (bug) => {
      const info = await inspectPlantedAgent(bug);

      expect(info.status).toBe("ready");
      expect(info.diagnostics?.errors).toBe(0);
    },
  );
});
