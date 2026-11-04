import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { emitVercelAgentSummary } from "#internal/nitro/host/build-vercel-agent-summary.js";
import { compileFromMemory } from "#internal/testing/compile-from-memory.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import { VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH } from "#internal/vercel-agent-summary.js";

describe("emitVercelAgentSummary agentRuns", () => {
  const createAppRoot = useTemporaryAppRoots();

  it.each([
    { agentRunsSource: undefined, enabled: true, label: "no agent-runs.ts" },
    {
      agentRunsSource: `import { agentRuns } from "eve/instrumentation/otel";
export default agentRuns({ exportPolicy: { span: () => ({ emit: true }) } });
`,
      enabled: true,
      label: "agentRuns(...)",
    },
    {
      agentRunsSource: `import { disableInstrumentation } from "eve/instrumentation";
export default disableInstrumentation();
`,
      enabled: false,
      label: "disableInstrumentation()",
    },
  ])("records enabled: $enabled for $label", async ({ agentRunsSource, enabled }) => {
    const { agentRoot, appRoot } = await createAppRoot("eve-agent-runs-summary-", {
      files:
        agentRunsSource === undefined
          ? {}
          : { "agent/instrumentation/agent-runs.ts": agentRunsSource },
    });
    const { manifest } = await compileFromMemory({
      agentRoot,
      appRoot,
      model: "openai/gpt-5.4",
    });
    const outputPath = join(appRoot, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH);

    await emitVercelAgentSummary({ appRoot, manifest, outputPath });

    const summary = JSON.parse(await readFile(outputPath, "utf8")) as { agentRuns?: unknown };
    expect(summary.agentRuns).toEqual({ enabled });
  });
});
