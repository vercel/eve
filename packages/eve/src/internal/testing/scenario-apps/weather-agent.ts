import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

const WEATHER_CLIENT_SOURCE = `/**
 * Deterministic weather response used by the shared weather-agent fixture.
 */
export function createForecast(city: string) {
  return {
    city,
    condition: "Sunny",
    summary: \`Sunny in \${city} with a light breeze.\`,
    temperatureF: 72,
  };
}
`;

const WEATHER_AGENT_SOURCE = `import { defineAgent } from "eve";
import { runtimeModelId } from "./lib/model.ts";

export default defineAgent({
  model: runtimeModelId,
});
`;

const WEATHER_MODEL_SOURCE = `/**
 * Shared model id used by the weather-agent fixture.
 */
export const runtimeModelId = "openai/gpt-5.4-mini";
`;

const WEATHER_TOOL_SOURCE = `import { defineTool } from "eve/tools";
import { z } from "zod";
import { createForecast } from "../lib/weather/client.ts";

export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({
    city: z.string(),
  }),
  async execute(input, ctx) {
    void ctx.session.auth.current?.authenticator;
    void ctx.session.auth.current?.principalId;
    void ctx.session.auth.initiator?.principalId;
    void ctx.session.parent?.runId;
    void ctx.session.parent?.sessionId;
    void ctx.session.turn.id;
    void ctx.session.turn.sequence;
    void ctx.session.parent?.turn.id;
    void ctx.session.parent?.turn.sequence;

    return createForecast(input.city);
  },
});
`;

const WEATHER_CHANNEL_WEBHOOK_SOURCE = `import { defineChannel, POST } from "eve/channels";

export default defineChannel({
  routes: [
    POST("/dev-smoke", async () => Response.json({ ok: true })),
  ],
});
`;

const WEATHER_SKILL_SOURCE = `---
description: Use the weather tool before answering forecast or temperature questions.
---

When the user asks about weather, temperature, or forecast conditions, call the \`get_weather\` tool before answering.
`;

const WEATHER_SYSTEM_SOURCE =
  "You are a weather-focused assistant. Be concise, accurate, and explicit about when you are using the local weather tool.\n";

const WEATHER_EVAL_CONFIG_SOURCE = `import { defineEvalConfig } from "eve/evals";

// Run-wide config shared by every eval. The optional \`judge\` model is the
// default for \`t.judge.*\` assertions, so individual evals need not repeat it.
export default defineEvalConfig({
  judge: { model: "openai/gpt-5.4-mini" },
});
`;

const WEATHER_EVAL_SOURCE = `import { defineEval } from "eve/evals";
import { loadYaml } from "eve/evals/loaders";

interface WeatherCase {
  id: string;
  prompt: string;
  expected_location: string | null;
  expected_tool: string | null;
  tags: string[];
}

// Dataset-driven evals default-export an array; ids derive from the file
// name plus a zero-padded index (weather/0000, weather/0001, ...).
const document = await loadYaml("evals/data/weather-cases.yaml");
const rows = Array.isArray(document.cases) ? (document.cases as WeatherCase[]) : [];

export default rows.map((row) =>
  defineEval({
    description: \`Validates the weather agent handles: \${row.prompt}\`,
    tags: row.tags,
    metadata: {
      expectedLocation: row.expected_location,
      expectedTool: row.expected_tool,
    },
    async test(t) {
      await t.send(row.prompt);
      t.succeeded();
    },
  }),
);
`;

const WEATHER_EVAL_DATA_SOURCE = `cases:
  - id: sunny-nyc
    prompt: "What is the weather in New York?"
    expected_location: "New York"
    expected_tool: "get_weather"
    tags:
      - weather
      - us-city
  - id: rainy-london
    prompt: "Tell me the weather in London"
    expected_location: "London"
    expected_tool: "get_weather"
    tags:
      - weather
      - eu-city
  - id: greeting
    prompt: "Hello, how are you?"
    expected_location: null
    expected_tool: null
    tags:
      - no-tool
`;

const WEATHER_TSCONFIG_SOURCE = `${JSON.stringify(
  {
    $schema: "https://json.schemastore.org/tsconfig",
    compilerOptions: {
      allowJs: true,
      erasableSyntaxOnly: true,
      forceConsistentCasingInFileNames: true,
      isolatedModules: true,
      lib: ["ES2024"],
      module: "esnext",
      moduleDetection: "force",
      moduleResolution: "bundler",
      noEmit: true,
      noFallthroughCasesInSwitch: true,
      noImplicitOverride: true,
      noUncheckedIndexedAccess: true,
      resolveJsonModule: true,
      rootDir: ".",
      skipLibCheck: true,
      strict: true,
      target: "ES2024",
      types: ["node"],
      useUnknownInCatchVariables: true,
      verbatimModuleSyntax: true,
    },
    exclude: ["node_modules", "dist", "build", ".turbo", ".vercel"],
    include: ["agent/**/*"],
  },
  null,
  2,
)}\n`;

/**
 * Scenario-tier descriptor for the shared weather-agent app used by the
 * `eve dev` HMR, port-retry, CLI, and public-API portability tests.
 *
 * The weather agent exposes a single `get_weather` tool whose authored
 * dependency (`agent/lib/weather/client.ts`) drives HMR assertions, plus a
 * Authored channel route used to exercise channel routing.
 */
export const WEATHER_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  dependencies: {
    zod: "^4.3.6",
  },
  files: {
    "agent/agent.ts": WEATHER_AGENT_SOURCE,
    "agent/channels/dev-smoke.ts": WEATHER_CHANNEL_WEBHOOK_SOURCE,
    "agent/lib/model.ts": WEATHER_MODEL_SOURCE,
    "agent/lib/weather/client.ts": WEATHER_CLIENT_SOURCE,
    "agent/skills/get-weather.md": WEATHER_SKILL_SOURCE,
    "agent/instructions.md": WEATHER_SYSTEM_SOURCE,
    "agent/tools/get_weather.ts": WEATHER_TOOL_SOURCE,
    "evals/data/weather-cases.yaml": WEATHER_EVAL_DATA_SOURCE,
    "evals/evals.config.ts": WEATHER_EVAL_CONFIG_SOURCE,
    "evals/weather.eval.ts": WEATHER_EVAL_SOURCE,
    "tsconfig.json": WEATHER_TSCONFIG_SOURCE,
  },
  installDependencies: true,
  name: "weather-agent",
};
