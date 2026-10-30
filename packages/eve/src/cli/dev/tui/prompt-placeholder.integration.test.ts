import { expect, it } from "vitest";

import { defaultDevelopmentExtensions } from "#compiler/development-extensions.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { createAgentSourceManifest } from "#discover/manifest.js";
import { buildAgentInfoResponse } from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import { AGENT_INSTRUCTIONS_TEMPLATE } from "#setup/scaffold/create/instructions-template.js";
import { initialPromptPlaceholder } from "./prompt-placeholder.js";

it("recognizes scaffold instructions and bundled capabilities through compiled agent info", async () => {
  const source = createAgentSourceManifest({
    agentId: "local-cues",
    agentRoot: "/virtual/local-cues/agent",
    appRoot: "/virtual/local-cues",
  });
  source.instructions.push({
    sourceId: "instructions.md",
    logicalPath: "instructions.md",
    sourceKind: "markdown",
    definition: { content: AGENT_INSTRUCTIONS_TEMPLATE },
  });
  const manifest = await compileAgentManifest(source, {
    developmentExtensions: defaultDevelopmentExtensions(),
  });
  const info = buildAgentInfoResponse(
    { manifest, schedules: [] },
    { mode: "development", gatewayCredentials: { apiKey: false, oidc: false } },
  );

  expect(initialPromptPlaceholder(info, true)).toBe(
    "Ask me to connect a channel, edit instructions, add a tool…",
  );
});
