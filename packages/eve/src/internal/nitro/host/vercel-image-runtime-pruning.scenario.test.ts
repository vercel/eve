import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { buildApplication } from "#internal/nitro/host/build-application.js";

const scenarioApp = useScenarioApp();

describe("experimental Vercel image runtime bundling", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    {
      constructor: "ExperimentalVercelDockerfile",
      environment: "ExperimentalVercelDockerfile.environment()",
      name: "vercel-image-runtime-pruning",
    },
    {
      constructor: "ExperimentalVercelReusedDockerfile",
      environment: 'ExperimentalVercelReusedDockerfile.environment({ key: "trusted-team" })',
      name: "vercel-reused-runtime-pruning",
    },
  ])("keeps OCI publication code out of $constructor hosted runtime output", async (fixture) => {
    vi.stubEnv("VERCEL", "1");
    const app = await scenarioApp({
      files: {
        "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };',
        "agent/instructions.md": "Use the sandbox.",
        "agent/sandbox/Dockerfile": "FROM alpine:3.22\n",
        "agent/sandbox/sandbox.ts": [
          'import { defineSandbox } from "eve/sandbox";',
          `import { ${fixture.constructor} } from "eve/sandbox/vercel";`,
          `export const environment = ${fixture.environment};`,
          "export default defineSandbox(() => environment.open());",
        ].join("\n"),
      },
      installDependencies: true,
      name: fixture.name,
    });

    const output = await buildApplication(app.appRoot, { skipVercelSandboxPrewarm: true });
    const source = await readJavaScript(join(output, "functions"));

    expect(source).toContain("OCI images cannot be published from a hosted server runtime");
    expect(source).not.toContain("eve-oci-digest-");
    expect(source).not.toContain("--compression-format");
    expect(source).not.toContain("short-name-mode");
  });
});

async function readJavaScript(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".js") || entry.endsWith(".mjs"))
        .map((entry) => readFile(join(root, entry), "utf8")),
    )
  ).join("\n");
}
